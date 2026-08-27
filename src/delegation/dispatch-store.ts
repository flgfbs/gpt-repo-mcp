import { ZodError } from "zod";
import {
  AdmittedDispatchSchema,
  WorkerLaunchIntentSchema,
  WorkerLaunchOutcomeSchema,
  WorkerLaunchResultSchema,
  type AdmittedDispatch,
  type WorkerLaunchIntent,
  type WorkerLaunchOutcome,
  type WorkerLaunchResult
} from "./execution-runtime-contracts.js";
import type { ExecutionSupervisorServiceIdentity } from "./artifact-contracts.js";
import { readSafeRunArtifact, writeExclusiveSafeRunJson } from "./safe-artifact.js";
import { runPaths } from "./run-store.js";
import { RepoReaderError } from "../runtime/errors.js";
import { canonicalSha256, digestRecord } from "../task-runtime/canonical-json.js";

const MAX_RECORD_BYTES = 256 * 1024;

export type AdmittedDispatchInput = Omit<
  AdmittedDispatch,
  "schema_version" | "dispatch_id" | "launch_ordinal" | "replay_policy" | "admitted_at" | "admission_sha256" | "record_sha256"
> & { admitted_at?: string };

export class DelegationDispatchStore {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async ensureAdmitted(input: AdmittedDispatchInput): Promise<{ dispatch: AdmittedDispatch; created: boolean }> {
    const stableBinding = {
      repo_id: input.repo_id,
      run_id: input.run_id,
      runner: input.runner,
      task_binding: input.task_binding,
      delegation_binding: input.delegation_binding,
      supervisor: input.supervisor,
      max_runtime_ms: input.max_runtime_ms,
      launch_ordinal: 1 as const,
      replay_policy: "never_after_launch_intent" as const
    };
    const admissionSha256 = canonicalSha256(stableBinding);
    const dispatchId = `dispatch_${admissionSha256}`;
    const candidateWithoutDigest = {
      schema_version: 1 as const,
      dispatch_id: dispatchId,
      ...stableBinding,
      admitted_at: input.admitted_at ?? this.now().toISOString(),
      admission_sha256: admissionSha256,
      record_sha256: "0".repeat(64)
    };
    const candidate = AdmittedDispatchSchema.parse({
      ...candidateWithoutDigest,
      record_sha256: digestRecord(candidateWithoutDigest, "record_sha256")
    });
    const existing = await this.readDispatch(input.run_id);
    if (existing) return { dispatch: assertSameDispatch(existing, candidate), created: false };
    const created = await writeExclusiveSafeRunJson(this.root, dispatchPaths(input.run_id).dispatch, candidate);
    if (created) return { dispatch: candidate, created: true };
    const raced = await this.readDispatch(input.run_id);
    if (!raced) throw invalidRecord("Immutable dispatch appeared concurrently but could not be read back.");
    return { dispatch: assertSameDispatch(raced, candidate), created: false };
  }

  async ensureLaunchIntent(
    dispatch: AdmittedDispatch,
    supervisor: ExecutionSupervisorServiceIdentity,
    requestedAt = this.now().toISOString()
  ): Promise<{ intent: WorkerLaunchIntent; created: boolean }> {
    if (!sameSupervisor(supervisor, dispatch.supervisor)) {
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Launch intent supervisor does not match the admitted dispatch.");
    }
    const existing = await this.readIntent(dispatch.run_id);
    if (existing) return { intent: assertIntent(existing, dispatch), created: false };
    const unsigned = {
      schema_version: 1 as const,
      dispatch_id: dispatch.dispatch_id,
      launch_ordinal: 1 as const,
      supervisor,
      requested_at: requestedAt,
      intent_sha256: "0".repeat(64)
    };
    const candidate = WorkerLaunchIntentSchema.parse({
      ...unsigned,
      intent_sha256: digestRecord(unsigned, "intent_sha256")
    });
    const created = await writeExclusiveSafeRunJson(this.root, dispatchPaths(dispatch.run_id).intent, candidate);
    if (created) return { intent: candidate, created: true };
    const raced = await this.readIntent(dispatch.run_id);
    if (!raced) throw invalidRecord("Immutable launch intent appeared concurrently but could not be read back.");
    return { intent: assertIntent(raced, dispatch), created: false };
  }

  async writeLaunchResult(input: {
    dispatch: AdmittedDispatch;
    outcome: WorkerLaunchOutcome;
    started_at: string;
    completed_at?: string;
  }): Promise<{ result: WorkerLaunchResult; created: boolean }> {
    const intent = await this.readIntent(input.dispatch.run_id);
    if (!intent) {
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "A launch result requires an immutable matching launch intent.");
    }
    assertIntent(intent, input.dispatch);
    const outcome = WorkerLaunchOutcomeSchema.parse(input.outcome);
    const unsigned = {
      schema_version: 1 as const,
      dispatch_id: input.dispatch.dispatch_id,
      launch_ordinal: 1 as const,
      ...outcome,
      started_at: input.started_at,
      completed_at: input.completed_at ?? this.now().toISOString(),
      replay_allowed: false as const,
      result_sha256: "0".repeat(64)
    };
    const candidate = WorkerLaunchResultSchema.parse({
      ...unsigned,
      result_sha256: digestRecord(unsigned, "result_sha256")
    });
    const existing = await this.readResult(input.dispatch.run_id);
    if (existing) return { result: assertSameResult(existing, candidate), created: false };
    const created = await writeExclusiveSafeRunJson(this.root, dispatchPaths(input.dispatch.run_id).result, candidate);
    if (created) return { result: candidate, created: true };
    const raced = await this.readResult(input.dispatch.run_id);
    if (!raced) throw invalidRecord("Immutable launch result appeared concurrently but could not be read back.");
    return { result: assertSameResult(raced, candidate), created: false };
  }

  async readDispatch(runId: string): Promise<AdmittedDispatch | undefined> {
    return readRecord(this.root, dispatchPaths(runId).dispatch, AdmittedDispatchSchema, verifyDispatch);
  }

  async readIntent(runId: string): Promise<WorkerLaunchIntent | undefined> {
    return readRecord(this.root, dispatchPaths(runId).intent, WorkerLaunchIntentSchema, verifyIntent);
  }

  async readResult(runId: string): Promise<WorkerLaunchResult | undefined> {
    return readRecord(this.root, dispatchPaths(runId).result, WorkerLaunchResultSchema, verifyResult);
  }
}

export function dispatchPaths(runId: string) {
  const runDir = runPaths(runId).run_dir;
  return {
    dispatch: `${runDir}/admitted-dispatch.json`,
    intent: `${runDir}/worker-launch-intent.json`,
    result: `${runDir}/worker-launch-result.json`
  };
}

async function readRecord<T>(
  root: string,
  path: string,
  schema: { parse(value: unknown): T },
  verify: (record: T) => void
): Promise<T | undefined> {
  const raw = await readSafeRunArtifact(root, path, MAX_RECORD_BYTES);
  if (raw === undefined) return undefined;
  try {
    const record = schema.parse(JSON.parse(raw));
    verify(record);
    return record;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RepoReaderError) throw invalidRecord(path);
    throw error;
  }
}

function verifyDispatch(record: AdmittedDispatch): void {
  if (record.dispatch_id !== `dispatch_${record.admission_sha256}`) throw invalidRecord("Dispatch id does not bind admission digest.");
  if (record.record_sha256 !== digestRecord(record, "record_sha256")) throw invalidRecord("Dispatch digest mismatch.");
  const stableBinding = {
    repo_id: record.repo_id,
    run_id: record.run_id,
    runner: record.runner,
    task_binding: record.task_binding,
    delegation_binding: record.delegation_binding,
    supervisor: record.supervisor,
    max_runtime_ms: record.max_runtime_ms,
    launch_ordinal: record.launch_ordinal,
    replay_policy: record.replay_policy
  };
  if (record.admission_sha256 !== canonicalSha256(stableBinding)) throw invalidRecord("Admission digest mismatch.");
}

function verifyIntent(record: WorkerLaunchIntent): void {
  if (record.intent_sha256 !== digestRecord(record, "intent_sha256")) throw invalidRecord("Launch-intent digest mismatch.");
}

function verifyResult(record: WorkerLaunchResult): void {
  if (record.result_sha256 !== digestRecord(record, "result_sha256")) throw invalidRecord("Launch-result digest mismatch.");
}

function assertSameDispatch(existing: AdmittedDispatch, candidate: AdmittedDispatch): AdmittedDispatch {
  verifyDispatch(existing);
  if (existing.admission_sha256 !== candidate.admission_sha256 || existing.dispatch_id !== candidate.dispatch_id) {
    throw new RepoReaderError("TASK_OPERATION_CONFLICT", "An immutable admitted dispatch already exists with different bindings.");
  }
  return existing;
}

function assertIntent(existing: WorkerLaunchIntent, dispatch: AdmittedDispatch): WorkerLaunchIntent {
  verifyIntent(existing);
  if (
    existing.dispatch_id !== dispatch.dispatch_id
    || existing.launch_ordinal !== 1
    || !sameSupervisor(existing.supervisor, dispatch.supervisor)
  ) {
    throw new RepoReaderError("TASK_OPERATION_CONFLICT", "An immutable launch intent is bound to another dispatch.");
  }
  return existing;
}

function sameSupervisor(
  left: ExecutionSupervisorServiceIdentity,
  right: ExecutionSupervisorServiceIdentity
): boolean {
  return left.schema_version === right.schema_version
    && left.service_id === right.service_id
    && left.instance_id === right.instance_id
    && left.implementation === right.implementation
    && left.protocol === right.protocol;
}

function assertSameResult(existing: WorkerLaunchResult, candidate: WorkerLaunchResult): WorkerLaunchResult {
  verifyResult(existing);
  if (existing.dispatch_id !== candidate.dispatch_id || existing.result_sha256 !== candidate.result_sha256) {
    throw new RepoReaderError("TASK_OPERATION_CONFLICT", "An immutable launch result already exists with different evidence.");
  }
  return existing;
}

function invalidRecord(detail: string): RepoReaderError {
  return new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Execution-runtime artifact is malformed, unsafe, or digest-mismatched.", {
    diagnostics: { detail }
  });
}
