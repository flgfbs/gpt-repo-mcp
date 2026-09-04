import { canonicalSha256 } from "../task-runtime/canonical-json.js";
import type { OperationPhase, OperationState, ObservedEffectState } from "../task-runtime/contracts.js";
import type { TaskRuntimeService } from "../task-runtime/task-service.js";
import type { RepoRunFableReviewInput } from "../contracts/fable-review.contract.js";
import type { NormalizedFableOutcome } from "./fable-review-normalizer.js";

const TERMINAL_PHASES = new Set<OperationPhase>([
  "LOCAL_MUTATION_COMPLETE",
  "EXTERNAL_SUCCEEDED",
  "FAILED_PRECONTACT",
  "FAILED_KNOWN_AFTER_CONTACT",
  "UNKNOWN_AFTER_CONTACT",
  "ROLLBACK_COMPLETE",
  "BLOCKED"
]);

export async function createFableReviewOperation(
  tasks: TaskRuntimeService,
  input: RepoRunFableReviewInput,
  now: Date
): Promise<OperationState> {
  const timestamp = now.toISOString();
  return tasks.states.writeOperation({
    schema_version: 1,
    task_id: input.task_id,
    operation_id: input.operation_id,
    kind: "FABLE_REVIEW",
    request_sha256: canonicalSha256(input),
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
}

export async function advanceFableReviewOperation(
  tasks: TaskRuntimeService,
  operation: OperationState,
  phase: OperationPhase,
  effect: ObservedEffectState,
  now: Date,
  errorCode?: string,
  resultRepoId?: string
): Promise<OperationState> {
  const { state_sha256: _stateSha256, ...current } = operation;
  const terminal = TERMINAL_PHASES.has(phase);
  const timestamp = now.toISOString();
  return tasks.states.writeOperation({
    ...current,
    phase,
    effect_state: effect,
    revision: operation.revision + 1,
    updated_at: timestamp,
    completed_at: terminal ? timestamp : null,
    result_repo_id: resultRepoId ?? operation.result_repo_id,
    error_code: errorCode ?? null,
    error_message: errorCode
      ? "Managed Fable review operation stopped with the recorded outcome code."
      : null
  });
}

export async function terminalizeFableReviewOperation(
  tasks: TaskRuntimeService,
  operation: OperationState,
  outcome: NormalizedFableOutcome,
  repoId: string,
  now: Date
): Promise<void> {
  if (outcome.review_state === "failed_precontact") {
    await advanceFableReviewOperation(
      tasks,
      operation,
      "FAILED_PRECONTACT",
      "ABSENT",
      now,
      outcome.outcome_code,
      repoId
    );
    return;
  }
  if (outcome.review_state === "unknown_effect") {
    await advanceFableReviewOperation(
      tasks,
      operation,
      "UNKNOWN_AFTER_CONTACT",
      "UNKNOWN",
      now,
      outcome.outcome_code,
      repoId
    );
    return;
  }
  const contacted = await advanceFableReviewOperation(
    tasks,
    operation,
    "EXTERNAL_CONTACTED",
    "UNKNOWN",
    now
  );
  if (outcome.review_state === "review_completed") {
    await advanceFableReviewOperation(
      tasks,
      contacted,
      "EXTERNAL_SUCCEEDED",
      "PRESENT",
      now,
      undefined,
      repoId
    );
    return;
  }
  await advanceFableReviewOperation(
    tasks,
    contacted,
    "FAILED_KNOWN_AFTER_CONTACT",
    "PARTIAL",
    now,
    outcome.outcome_code,
    repoId
  );
}

export function isTerminalFableOperation(operation: OperationState): boolean {
  return TERMINAL_PHASES.has(operation.phase);
}
