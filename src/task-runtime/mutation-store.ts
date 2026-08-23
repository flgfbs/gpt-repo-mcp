import { posix } from "node:path";
import { z } from "zod";
import { canonicalJson, digestRecord, hashedDiskKey } from "./canonical-json.js";
import { TaskRuntimeError } from "./errors.js";
import { hasCode, SecureRuntimeFs } from "./secure-runtime-fs.js";

const MutationPhaseSchema = z.enum(["ADMITTED", "LOCAL_MUTATION_STARTED", "LOCAL_MUTATION_COMPLETE", "BLOCKED"]);
const MutationRecordSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.string().min(8).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  task_id: z.string().min(1).max(128),
  repo_id: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: MutationPhaseSchema,
  before_head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  before_tree_sha: z.string().regex(/^[a-f0-9]{40}$/),
  after_head_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  after_tree_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  result_is_error: z.boolean().optional(),
  failure_code: z.string().min(1).max(120).optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  state_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((value, context) => {
  const completed = value.phase === "LOCAL_MUTATION_COMPLETE";
  if (completed !== Boolean(value.result_sha256 && value.after_head_sha && value.after_tree_sha)) {
    context.addIssue({ code: "custom", path: ["result_sha256"], message: "Completed task mutations require exact result and after-state digests." });
  }
  if ((value.phase === "BLOCKED") !== (value.failure_code !== undefined)) {
    context.addIssue({ code: "custom", path: ["failure_code"], message: "Blocked task mutations require one stable failure code." });
  }
});

export type TaskMutationRecord = z.infer<typeof MutationRecordSchema>;
export type TaskMutationPhase = z.infer<typeof MutationPhaseSchema>;

export class TaskMutationStore {
  constructor(private readonly fs: SecureRuntimeFs) {}

  async initialize(): Promise<void> {
    await this.fs.ensureDirectory("mutations");
  }

  async read(operationId: string): Promise<TaskMutationRecord | undefined> {
    await this.initialize();
    try {
      const raw = await this.fs.readFile(pathFor(operationId), 64 * 1024);
      const record = MutationRecordSchema.parse(JSON.parse(raw.toString("utf8")));
      if (
        record.operation_id !== operationId
        || digestRecord(record as TaskMutationRecord & Record<string, unknown>, "state_sha256") !== record.state_sha256
      ) throw tampered();
      return record;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof TaskRuntimeError) throw error;
      throw tampered();
    }
  }

  async create(input: Omit<TaskMutationRecord, "schema_version" | "state_sha256">): Promise<TaskMutationRecord> {
    const existing = await this.read(input.operation_id);
    if (existing) return existing;
    const record = sign({ schema_version: 1, ...input });
    try {
      await this.fs.atomicWrite(pathFor(record.operation_id), `${canonicalJson(record)}\n`, { exclusive: true });
      return record;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const raced = await this.read(input.operation_id);
      if (!raced) throw tampered();
      return raced;
    }
  }

  async transition(
    previous: TaskMutationRecord,
    phase: TaskMutationPhase,
    changes: Partial<Pick<TaskMutationRecord,
      "after_head_sha" | "after_tree_sha" | "result_sha256" | "result_is_error" | "failure_code"
    >>,
    updatedAt: string
  ): Promise<TaskMutationRecord> {
    const current = await this.read(previous.operation_id);
    if (!current || current.state_sha256 !== previous.state_sha256) {
      throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Task mutation state changed outside the admitted transition.");
    }
    assertTransition(previous.phase, phase);
    const record = sign({ ...previous, ...changes, phase, updated_at: updatedAt, state_sha256: undefined });
    await this.fs.atomicWrite(pathFor(record.operation_id), `${canonicalJson(record)}\n`);
    return record;
  }
}

function pathFor(operationId: string): string {
  return posix.join("mutations", `${hashedDiskKey("task-mutation", operationId)}.json`);
}

function sign(value: Omit<TaskMutationRecord, "state_sha256"> & { state_sha256?: string }): TaskMutationRecord {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.state_sha256;
  return MutationRecordSchema.parse({ ...unsigned, state_sha256: digestRecord(unsigned, "state_sha256") });
}

function assertTransition(from: TaskMutationPhase, to: TaskMutationPhase): void {
  const permitted: Record<TaskMutationPhase, readonly TaskMutationPhase[]> = {
    ADMITTED: ["LOCAL_MUTATION_STARTED", "BLOCKED"],
    LOCAL_MUTATION_STARTED: ["LOCAL_MUTATION_COMPLETE", "BLOCKED"],
    LOCAL_MUTATION_COMPLETE: [],
    BLOCKED: []
  };
  if (!permitted[from].includes(to)) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", `Invalid task mutation transition: ${from} -> ${to}.`);
  }
}

function tampered(): TaskRuntimeError {
  return new TaskRuntimeError("TASK_STATE_TAMPERED", "Task mutation state is malformed or its digest does not match.");
}
