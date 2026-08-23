import { posix } from "node:path";
import { ZodError } from "zod";
import { canonicalJson, digestRecord, hashedDiskKey } from "./canonical-json.js";
import {
  OperationStateSchema,
  OperationIdSchema,
  TaskIdSchema,
  TaskStateSchema,
  type OperationPhase,
  type OperationState,
  type TaskState
} from "./contracts.js";
import { TaskRuntimeError } from "./errors.js";
import { hasCode, SecureRuntimeFs } from "./secure-runtime-fs.js";

const MAX_STATE_BYTES = 256 * 1024;

const ALLOWED_OPERATION_TRANSITIONS: Readonly<Record<OperationPhase, ReadonlySet<OperationPhase>>> = {
  CREATED: new Set(["ADMITTED", "FAILED_PRECONTACT", "BLOCKED"]),
  ADMITTED: new Set(["LOCAL_MUTATION_STARTED", "LOCAL_MUTATION_COMPLETE", "EXTERNAL_PRECONTACT", "FAILED_PRECONTACT", "BLOCKED"]),
  LOCAL_MUTATION_STARTED: new Set(["LOCAL_MUTATION_COMPLETE", "BLOCKED"]),
  LOCAL_MUTATION_COMPLETE: new Set(),
  EXTERNAL_PRECONTACT: new Set(["EXTERNAL_CONTACTED", "FAILED_PRECONTACT", "BLOCKED"]),
  EXTERNAL_CONTACTED: new Set(["EXTERNAL_SUCCEEDED", "FAILED_KNOWN_AFTER_CONTACT", "UNKNOWN_AFTER_CONTACT", "BLOCKED"]),
  EXTERNAL_SUCCEEDED: new Set(["ROLLBACK_COMPLETE"]),
  FAILED_PRECONTACT: new Set(),
  FAILED_KNOWN_AFTER_CONTACT: new Set(["ROLLBACK_COMPLETE", "BLOCKED"]),
  UNKNOWN_AFTER_CONTACT: new Set(["ROLLBACK_COMPLETE", "BLOCKED"]),
  ROLLBACK_COMPLETE: new Set(),
  BLOCKED: new Set(["ROLLBACK_COMPLETE"])
};

export class TaskStateStore {
  constructor(readonly fs: SecureRuntimeFs) {}

  async initialize(): Promise<void> {
    await Promise.all([
      this.fs.ensureDirectory("tasks"),
      this.fs.ensureDirectory("operations"),
      this.fs.ensureDirectory("locks"),
      this.fs.ensureDirectory("cas/sha256")
    ]);
  }

  taskDirectory(taskId: string): string {
    return posix.join("tasks", hashedDiskKey("task", TaskIdSchema.parse(taskId)));
  }

  taskStatePath(taskId: string): string {
    return posix.join(this.taskDirectory(taskId), "state.json");
  }

  operationStatePath(taskId: string, operationId: string): string {
    const parsedTaskId = TaskIdSchema.parse(taskId);
    const parsedOperationId = OperationIdSchema.parse(operationId);
    return posix.join(
      "operations",
      hashedDiskKey("operation-task", parsedTaskId),
      `${hashedDiskKey("operation", parsedOperationId)}.json`
    );
  }

  async readTask(taskId: string): Promise<TaskState | undefined> {
    return this.readDigested(this.taskStatePath(taskId), TaskStateSchema, "task", taskId);
  }

  async requireTask(taskId: string): Promise<TaskState> {
    const task = await this.readTask(taskId);
    if (!task) throw new TaskRuntimeError("TASK_STATE_NOT_FOUND", "Task state does not exist.", { task_id: taskId });
    return task;
  }

  async listTasks(options: { limit?: number } = {}): Promise<TaskState[]> {
    const limit = boundedListLimit(options.limit ?? 1_000);
    const entries = await this.fs.listDirectory("tasks", limit);
    const tasks: TaskState[] = [];
    for (const entry of entries) {
      if (entry.kind !== "directory" || !/^[a-f0-9]{64}$/.test(entry.name)) {
        throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Task state directory contains an unsafe or malformed entry.", {
          disk_key: entry.name,
          kind: entry.kind
        });
      }
      const relativePath = posix.join("tasks", entry.name, "state.json");
      let task: TaskState;
      try {
        const raw = await this.fs.readFile(relativePath, MAX_STATE_BYTES);
        task = TaskStateSchema.parse(JSON.parse(raw.toString("utf8")));
      } catch (error) {
        if (error instanceof TaskRuntimeError) throw error;
        throw tampered("task");
      }
      if (
        digestRecord(task as TaskState & Record<string, unknown>, "state_sha256") !== task.state_sha256
        || hashedDiskKey("task", task.task_id) !== entry.name
      ) {
        throw tampered("task");
      }
      tasks.push(task);
    }
    return tasks.sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  async writeTask(value: Omit<TaskState, "state_sha256"> & { state_sha256?: string }): Promise<TaskState> {
    const unsigned = omitUndefined(value as Record<string, unknown>);
    delete unsigned.state_sha256;
    const parsed = TaskStateSchema.parse({ ...unsigned, state_sha256: digestRecord(unsigned, "state_sha256") });
    await this.fs.atomicWrite(this.taskStatePath(parsed.task_id), `${canonicalJson(parsed)}\n`);
    return parsed;
  }

  async readOperation(taskId: string, operationId: string): Promise<OperationState | undefined> {
    return this.readDigested(this.operationStatePath(taskId, operationId), OperationStateSchema, "operation", `${taskId}:${operationId}`);
  }

  async writeOperation(value: Omit<OperationState, "state_sha256"> & { state_sha256?: string }): Promise<OperationState> {
    const unsigned = omitUndefined(value as Record<string, unknown>);
    delete unsigned.state_sha256;
    const parsed = OperationStateSchema.parse({ ...unsigned, state_sha256: digestRecord(unsigned, "state_sha256") });
    const previous = await this.readOperation(parsed.task_id, parsed.operation_id);
    if (previous) {
      if (previous.request_sha256 !== parsed.request_sha256 || previous.kind !== parsed.kind) {
        throw new TaskRuntimeError("OPERATION_ID_CONFLICT", "operation_id is already bound to a different request.");
      }
      if (previous.phase !== parsed.phase) assertOperationTransition(previous.phase, parsed.phase);
      if (parsed.revision !== previous.revision + 1) {
        throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "Operation revisions must increase by exactly one.");
      }
    } else if (parsed.phase !== "CREATED" || parsed.revision !== 0) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "New operations must begin at CREATED revision zero.");
    }
    await this.fs.atomicWrite(this.operationStatePath(parsed.task_id, parsed.operation_id), `${canonicalJson(parsed)}\n`);
    return parsed;
  }

  private async readDigested<T extends { state_sha256: string }>(
    relativePath: string,
    schema: { parse(value: unknown): T },
    kind: string,
    expectedIdentity: string
  ): Promise<T | undefined> {
    try {
      const raw = await this.fs.readFile(relativePath, MAX_STATE_BYTES);
      const value = schema.parse(JSON.parse(raw.toString("utf8")));
      if (digestRecord(value as T & Record<string, unknown>, "state_sha256") !== value.state_sha256) throw tampered(kind);
      const actualIdentity = kind === "task"
        ? (value as unknown as TaskState).task_id
        : `${(value as unknown as OperationState).task_id}:${(value as unknown as OperationState).operation_id}`;
      if (actualIdentity !== expectedIdentity) throw tampered(kind);
      return value;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof SyntaxError || error instanceof ZodError) throw tampered(kind);
      throw error;
    }
  }
}

export function assertOperationTransition(from: OperationPhase, to: OperationPhase): void {
  if (!ALLOWED_OPERATION_TRANSITIONS[from].has(to)) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", `Invalid operation phase transition: ${from} -> ${to}.`);
  }
}

function tampered(kind: string): TaskRuntimeError {
  return new TaskRuntimeError("TASK_STATE_TAMPERED", `${kind} state is malformed or its content digest does not match.`);
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function boundedListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "Task list limit must be an integer between 1 and 10000.");
  }
  return value;
}
