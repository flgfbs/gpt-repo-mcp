import { lstat, opendir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { OperationState, TaskState } from "../task-runtime/contracts.js";
import { TaskIdSchema } from "../task-runtime/contracts.js";
import { SecureRuntimeFs, hasCode } from "../task-runtime/secure-runtime-fs.js";
import { TaskStateStore } from "../task-runtime/state-store.js";
import { OwnerCliError } from "./cli-types.js";

const MAX_TASKS = 10_000;
const MAX_OPERATIONS = 10_000;

export interface OwnerTaskStateReader {
  listTasks(limit: number): Promise<TaskState[]>;
  inspectTask(taskId: string): Promise<{ task: TaskState; operations: OperationState[] }>;
}

export class DurableOwnerTaskStateReader implements OwnerTaskStateReader {
  constructor(private readonly runtimeRoot: string) {}

  async listTasks(limit: number): Promise<TaskState[]> {
    assertLimit(limit, MAX_TASKS, "task list");
    const store = await this.openStore();
    if (!store) return [];
    await preflightPrivateEntries(join(this.runtimeRoot, "tasks"), limit, "directory", "task state");
    return store.listTasks({ limit });
  }

  async inspectTask(taskIdInput: string): Promise<{ task: TaskState; operations: OperationState[] }> {
    const taskId = TaskIdSchema.parse(taskIdInput);
    const store = await this.openStore();
    if (!store) throw new OwnerCliError("TASK_NOT_FOUND", `Task does not exist: ${taskId}`);
    const taskDirectory = store.taskDirectory(taskId);
    const absoluteTaskDirectory = join(this.runtimeRoot, ...taskDirectory.split("/"));
    if (!await pathExists(absoluteTaskDirectory)) throw new OwnerCliError("TASK_NOT_FOUND", `Task does not exist: ${taskId}`);
    await assertPrivateDirectory(absoluteTaskDirectory, "task state directory");
    await assertPrivateFile(join(this.runtimeRoot, ...store.taskStatePath(taskId).split("/")), "task state file");
    const task = await store.readTask(taskId);
    if (!task) throw new OwnerCliError("TASK_NOT_FOUND", `Task does not exist: ${taskId}`);

    const operationDirectory = join(
      this.runtimeRoot,
      ...posix.dirname(store.operationStatePath(taskId, "probe")).split("/")
    );
    if (await pathExists(operationDirectory)) {
      await assertPrivateDirectory(operationDirectory, "task operation directory");
      await preflightPrivateEntries(operationDirectory, MAX_OPERATIONS, "file", "task operation");
    }
    const operations = await store.listOperationsForTask(taskId, { limit: MAX_OPERATIONS });
    return { task, operations };
  }

  private async openStore(): Promise<TaskStateStore | undefined> {
    if (!await pathExists(this.runtimeRoot)) return undefined;
    await assertPrivateDirectory(this.runtimeRoot, "runtime root");
    const tasksDirectory = join(this.runtimeRoot, "tasks");
    if (!await pathExists(tasksDirectory)) return undefined;
    await assertPrivateDirectory(tasksDirectory, "task state root");
    return new TaskStateStore(new SecureRuntimeFs(this.runtimeRoot));
  }
}

async function preflightPrivateEntries(
  directory: string,
  limit: number,
  kind: "file" | "directory",
  label: string
): Promise<void> {
  const handle = await opendir(directory);
  let count = 0;
  try {
    for await (const entry of handle) {
      count += 1;
      if (count > limit) throw new OwnerCliError("RUNTIME_SIZE_LIMIT", `${label} entries exceed the bounded limit.`);
      const path = join(directory, entry.name);
      if (kind === "directory") {
        await assertPrivateDirectory(path, label);
        await assertPrivateFile(join(path, "state.json"), `${label} file`);
      } else {
        await assertPrivateFile(path, label);
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o700
    || (uid !== undefined && stats.uid !== uid)
  ) {
    throw new OwnerCliError("RUNTIME_PRIVACY_INVALID", `${label} must be an owner-only mode-0700 real directory.`);
  }
}

async function assertPrivateFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || (stats.mode & 0o777) !== 0o600
    || (uid !== undefined && stats.uid !== uid)
  ) {
    throw new OwnerCliError("RUNTIME_PRIVACY_INVALID", `${label} must be an owner-only mode-0600 single-link file.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function assertLimit(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new OwnerCliError("INVALID_LIMIT", `${label} limit must be an integer from 1 to ${maximum}.`);
  }
}
