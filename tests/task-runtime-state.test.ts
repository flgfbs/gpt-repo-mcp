import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJson, canonicalSha256, digestRecord, hashedDiskKey } from "../src/task-runtime/canonical-json.js";
import { OperationPhaseSchema, type TaskState } from "../src/task-runtime/contracts.js";
import { CrossProcessLockManager } from "../src/task-runtime/cross-process-lock.js";
import { TaskRuntimeError } from "../src/task-runtime/errors.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";
import { TaskStateStore } from "../src/task-runtime/state-store.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable task runtime state", () => {
  test("canonical JSON and digests are independent of object insertion order", () => {
    const left = { zebra: [3, { beta: true, alpha: null }], alpha: "value" };
    const right = { alpha: "value", zebra: [3, { alpha: null, beta: true }] };
    expect(canonicalJson(left)).toBe('{"alpha":"value","zebra":[3,{"alpha":null,"beta":true}]}');
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
    expect(hashedDiskKey("task", "caller-visible-id")).toMatch(/^[a-f0-9]{64}$/);
  });

  test("persists strict digested state in hashed private paths and detects tampering", async () => {
    const { root, store } = await fixture();
    const task = await store.writeTask(taskInput("task-private"));
    await store.writeTask(taskInput("task-private-second"));
    const taskDirectory = store.taskDirectory(task.task_id);
    expect(taskDirectory).not.toContain(task.task_id);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(store.fs.absolutePath(taskDirectory))).mode & 0o777).toBe(0o700);
    expect((await stat(store.fs.absolutePath(store.taskStatePath(task.task_id)))).mode & 0o777).toBe(0o600);
    expect(task.state_sha256).toBe(digestRecord(task as TaskState & Record<string, unknown>, "state_sha256"));
    expect((await store.listTasks()).map((entry) => entry.task_id)).toEqual(["task-private", "task-private-second"]);

    const path = store.fs.absolutePath(store.taskStatePath(task.task_id));
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    parsed.goal = "tampered";
    await writeFile(path, JSON.stringify(parsed), { mode: 0o600 });
    await expect(store.readTask(task.task_id)).rejects.toMatchObject({ code: "TASK_STATE_TAMPERED" });
    await expect(store.listTasks()).rejects.toMatchObject({ code: "TASK_STATE_TAMPERED" });
  });

  test("rejects a symlink substituted for a state file", async () => {
    const { root, store } = await fixture();
    const task = await store.writeTask(taskInput("task-symlink"));
    const statePath = store.fs.absolutePath(store.taskStatePath(task.task_id));
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify(task), { mode: 0o600 });
    await unlink(statePath);
    await symlink(outside, statePath);
    expect((await lstat(statePath)).isSymbolicLink()).toBe(true);
    await expect(store.readTask(task.task_id)).rejects.toBeInstanceOf(TaskRuntimeError);
  });

  test("rejects a persistent hard link substituted for private state", async () => {
    const { root, store } = await fixture();
    const task = await store.writeTask(taskInput("task-hard-link"));
    const statePath = store.fs.absolutePath(store.taskStatePath(task.task_id));
    await link(statePath, join(root, "hard-link-alias.json"));
    await expect(store.readTask(task.task_id)).rejects.toMatchObject({ code: "RUNTIME_FILE_UNSAFE" });
  });

  test("rejects a symlink substituted for a managed runtime directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "task-directory-link-"));
    roots.push(parent);
    const runtime = join(parent, "runtime");
    const outside = join(parent, "outside");
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(runtime, "tasks"));
    const store = new TaskStateStore(new SecureRuntimeFs(runtime));
    await expect(store.initialize()).rejects.toMatchObject({ code: "RUNTIME_PATH_UNSAFE" });
  });

  test("uses the exact external-effect phase enum and rejects invalid transitions", async () => {
    expect(OperationPhaseSchema.options).toEqual([
      "CREATED",
      "ADMITTED",
      "LOCAL_MUTATION_STARTED",
      "LOCAL_MUTATION_COMPLETE",
      "EXTERNAL_PRECONTACT",
      "EXTERNAL_CONTACTED",
      "EXTERNAL_SUCCEEDED",
      "FAILED_PRECONTACT",
      "FAILED_KNOWN_AFTER_CONTACT",
      "UNKNOWN_AFTER_CONTACT",
      "ROLLBACK_COMPLETE",
      "BLOCKED"
    ]);
    const { store } = await fixture();
    const timestamp = new Date().toISOString();
    const operation = await store.writeOperation({
      schema_version: 1,
      task_id: "task-transition",
      operation_id: "operation-transition",
      kind: "OPEN",
      request_sha256: "a".repeat(64),
      phase: "CREATED",
      effect_state: "NOT_STARTED",
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      result_repo_id: null,
      error_code: null,
      error_message: null
    });
    await expect(store.writeOperation({
      ...operation,
      phase: "LOCAL_MUTATION_COMPLETE",
      effect_state: "PRESENT",
      completed_at: timestamp,
      revision: 1
    }))
      .rejects.toMatchObject({ code: "TASK_RUNTIME_INVALID" });
  });

  test("serializes independent lock-manager instances with a bounded disk lock", async () => {
    const { fs } = await fixture();
    const first = new CrossProcessLockManager(fs, { timeoutMs: 2_000, pollMs: 5 });
    const second = new CrossProcessLockManager(fs, { timeoutMs: 2_000, pollMs: 5 });
    let active = 0;
    let maximum = 0;
    const order: string[] = [];
    const critical = (name: string, delay: number) => async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(`${name}:start`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      order.push(`${name}:end`);
      active -= 1;
    };
    await Promise.all([
      first.withLock("shared-task", critical("first", 35)),
      second.withLock("shared-task", critical("second", 1))
    ]);
    expect(maximum).toBe(1);
    expect(order).toHaveLength(4);
  });

  test("coordinates the same lock key with a separate Node process", async () => {
    const { root, fs } = await fixture();
    const manager = new CrossProcessLockManager(fs, { timeoutMs: 3_000, pollMs: 5 });
    const release = await manager.acquire("cross-process-task");
    const childCode = [
      'import { SecureRuntimeFs } from "./src/task-runtime/secure-runtime-fs.ts";',
      'import { CrossProcessLockManager } from "./src/task-runtime/cross-process-lock.ts";',
      'const fs = new SecureRuntimeFs(process.env.TASK_RUNTIME_TEST_ROOT);',
      'const locks = new CrossProcessLockManager(fs, { timeoutMs: 3000, pollMs: 5 });',
      'await locks.withLock("cross-process-task", async () => undefined);',
      'process.stdout.write("acquired");'
    ].join("\n");
    const child = execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", TASK_RUNTIME_TEST_ROOT: root },
      timeout: 4_000
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await release();
    expect((await child).stdout).toBe("acquired");
  });
});

async function fixture(): Promise<{ root: string; fs: SecureRuntimeFs; store: TaskStateStore }> {
  const parent = await mkdtemp(join(tmpdir(), "task-state-test-"));
  roots.push(parent);
  const root = join(parent, "runtime");
  const fs = new SecureRuntimeFs(root);
  const store = new TaskStateStore(fs);
  await store.initialize();
  return { root, fs, store };
}

function taskInput(taskId: string): Omit<TaskState, "state_sha256"> {
  const timestamp = new Date().toISOString();
  return {
    schema_version: 1,
    task_id: taskId,
    repo_id: `task-${"a".repeat(40)}`,
    base_repo_id: "owner",
    base_branch: "main",
    base_commit: "1".repeat(40),
    base_tree: "2".repeat(40),
    authority: "implement",
    goal: "Exercise durable state.",
    branch_slug: "durable-state",
    server_branch: `chat-pro/tasks/durable-state-${hashedDiskKey("task-worktree", taskId).slice(0, 12)}`,
    worktree_path: `/tmp/durable-state-${taskId}`,
    lifecycle: "OPEN",
    worktree_state: "PRESENT",
    branch_state: "PRESENT",
    worktree_head: "1".repeat(40),
    worktree_tree: "2".repeat(40),
    registration_state: "REGISTERED",
    close_disposition: null,
    closed_at: null,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp
  };
}
