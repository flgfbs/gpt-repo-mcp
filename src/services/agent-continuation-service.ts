import {
  AgentContinuationInputSchema,
  AgentContinuationResultSchema,
  type AgentContinuationInput,
  type AgentContinuationResult
} from "../contracts/agent-continuation.contract.js";
import { CodexAppServerAdapter, CodexAppServerTurnStartError } from "../delegation/codex-app-server-adapter.js";
import type { PreparedCodexThread } from "../delegation/codex-app-server-adapter.js";
import { DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS, type AgentRunnerAttempt, type AgentRunnerSession, type AgentRunnerStatus } from "../delegation/artifact-contracts.js";
import { DelegationAttemptStore } from "../delegation/attempt-store.js";
import { DelegationInteractionStore } from "../delegation/interaction-store.js";
import { DelegationRunStore } from "../delegation/run-store.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { RepoReaderError } from "../runtime/errors.js";
import {
  canonicalSha256,
  type ObservedEffectState,
  type OperationPhase,
  type OperationState,
  type TaskRuntimeService
} from "../task-runtime/index.js";
import type { RootRegistry, TaskRepoBinding } from "./root-registry.js";
import { codexRunPaths } from "./codex-run-paths.js";

const CONTINUABLE_STATUSES = new Set([
  "completed",
  "failed"
]);

export interface AgentContinuationRuntime {
  continue(input: AgentContinuationInput): Promise<AgentContinuationResult>;
}

/**
 * Operation-bound continuation of one existing managed Codex App Server run.
 * The existing task operation ledger owns replay prevention; runner session and
 * attempt artifacts remain private run-local execution evidence.
 */
export class TaskAgentContinuationRuntime implements AgentContinuationRuntime {
  private readonly now: () => Date;

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    private readonly appServer: CodexAppServerAdapter,
    now: () => Date = () => new Date()
  ) {
    this.now = now;
  }

  async continue(rawInput: AgentContinuationInput): Promise<AgentContinuationResult> {
    const input = AgentContinuationInputSchema.parse(rawInput);
    const repo = this.registry.get(input.repo_id);
    const binding = repo.task;
    if (!binding || binding.authority === "inspect") {
      throw new RepoReaderError(
        "LIFECYCLE_POLICY_DENIED",
        "Agent continuation requires an active implement or ship task repository."
      );
    }
    await this.tasks.initialize();
    return this.tasks.locks.withLock(
      `agent-continuation-operation:${binding.task_id}:${input.operation_id}`,
      async () => this.tasks.locks.withLock(
        `task:${binding.task_id}`,
        async () => this.tasks.locks.withLock(
          `agent-run:${binding.task_id}:${input.run_id}`,
          async () => this.continueLocked(input, repo.root, binding)
        )
      )
    );
  }

  private async continueLocked(
    input: AgentContinuationInput,
    repoRoot: string,
    binding: TaskRepoBinding
  ): Promise<AgentContinuationResult> {
    let operation = await this.ensureOperation(input, binding.task_id);
    if (operation.phase !== "CREATED") throw existingOperationError(operation, input);
    operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");

    const runs = new DelegationRunStore(repoRoot, { now: this.now });
    const interactions = new DelegationInteractionStore(repoRoot, this.now);
    const attempts = new DelegationAttemptStore(repoRoot, this.now);
    let status: AgentRunnerStatus;
    let session: AgentRunnerSession;
    let prepared: PreparedCodexThread;
    let previousAttempt: AgentRunnerAttempt;
    let resultSha256Before: string | undefined;
    try {
      const task = await this.tasks.states.requireTask(binding.task_id);
      if (
        task.repo_id !== input.repo_id
        || task.lifecycle !== "OPEN"
        || task.registration_state !== "REGISTERED"
        || task.close_disposition !== null
        || task.authority === "inspect"
        || task.server_branch !== binding.branch
        || task.worktree_path !== repoRoot
      ) {
        throw new RepoReaderError(
          "TASK_STATE_MISMATCH",
          "Current task identity or authority does not match the selected continuation repository."
        );
      }

      const run = await runs.readRun(input.run_id);
      if (
        run.repo_id !== input.repo_id
        || run.manifest.schema_version !== 3
        || run.runner.mode !== "queued"
        || run.runner.requested_runner !== "codex_app_server"
      ) {
        throw new RepoReaderError(
          "RUNNER_POLICY_BLOCKED",
          "The selected run is not a managed Codex App Server child; implicit provider fallback is forbidden."
        );
      }
      const loadedStatus = await runs.readStatus(input.run_id);
      if (!loadedStatus || loadedStatus.repo_id !== input.repo_id || loadedStatus.runner !== "codex_app_server") {
        throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Managed runner status is missing or mismatched.");
      }
      status = loadedStatus;
      if (status.revision !== input.expected_revision) {
        throw new RepoReaderError("TASK_STATE_MISMATCH", "Agent run revision changed before continuation.", {
          diagnostics: { expected_revision: input.expected_revision, observed_revision: status.revision }
        });
      }
      if (status.status === "awaiting_input") {
        throw new RepoReaderError(
          "RUNNER_POLICY_BLOCKED",
          "The run is awaiting structured input; use repo_write_agent_reply instead of starting another turn."
        );
      }
      if (!CONTINUABLE_STATUSES.has(status.status)) {
        throw new RepoReaderError("RUNNER_LOCK_ACTIVE", "The selected run is not in a continuable terminal state.");
      }
      const formalReview = await readSafeRunArtifact(repoRoot, codexRunPaths(input.run_id).reviewPath, 128 * 1024);
      if (formalReview !== undefined) {
        throw new RepoReaderError(
          "RUNNER_POLICY_BLOCKED",
          "The selected run already has a state-bound review; use the existing corrective-child lineage instead."
        );
      }

      const loadedSession = await interactions.readSession(input.repo_id, input.run_id);
      if (!loadedSession || loadedSession.provider !== "codex_app_server") {
        throw new RepoReaderError(
          "RUNNER_INTERACTION_INVALID",
          "The selected run has no matching private Codex App Server session."
        );
      }
      session = loadedSession;
      if (!session.model) {
        throw new RepoReaderError(
          "RUNNER_INTERACTION_INVALID",
          "The private Codex App Server session has no exact model binding for continuation."
        );
      }
      if (session.turn_index >= 32) {
        throw new RepoReaderError("RUNNER_MAX_TURNS", "The managed run has reached its bounded turn limit.");
      }
      const effectiveRuntimeLimit = Math.min(
        DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        run.runner.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        session.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
      );
      if (session.active_runtime_ms >= effectiveRuntimeLimit) {
        throw new RepoReaderError("RUNNER_POLICY_BLOCKED", "The managed run has exhausted its bounded active runtime.");
      }
      const loadedAttempt = await attempts.read(input.repo_id, input.run_id);
      if (loadedAttempt?.state === "in_flight") {
        throw new RepoReaderError("RUNNER_LOCK_ACTIVE", "The managed run already has an in-flight turn.");
      }
      if (
        !loadedAttempt
        || loadedAttempt.provider !== "codex_app_server"
        || loadedAttempt.turn_index !== session.turn_index
      ) {
        throw new RepoReaderError("RUNNER_INTERACTION_INVALID", "Private runner attempt state does not match the current session.");
      }
      previousAttempt = loadedAttempt;
      const previousResult = await readSafeRunArtifact(repoRoot, run.result_json_path, 4 * 1024 * 1024);
      resultSha256Before = previousResult === undefined ? undefined : canonicalSha256(previousResult);
      prepared = await this.appServer.prepare({
        thread_id: session.thread_id,
        model: session.model,
        repo_root: repoRoot
      });
    } catch (error) {
      await this.fail(operation, "FAILED_PRECONTACT", "NOT_STARTED", stablePrecontactCode(error));
      throw publicPrecontactError(error);
    }

    operation = await this.advance(operation, "EXTERNAL_PRECONTACT", "NOT_STARTED");
    const startedAt = this.now().toISOString();
    const turnIndex = session.turn_index + 1;
    try {
      await attempts.write({
        repo_id: input.repo_id,
        run_id: input.run_id,
        provider: "codex_app_server",
        operation: "resume",
        turn_index: turnIndex,
        state: "in_flight",
        ...(resultSha256Before === undefined ? {} : { result_sha256_before: resultSha256Before }),
        active_runtime_ms_before: session.active_runtime_ms,
        started_at: startedAt
      });
    } catch {
      await this.settleBeforeTurnStartFailure(operation, attempts, previousAttempt, "CONTINUATION_STATE_PERSIST_FAILED");
      throw localStateFailure();
    }
    try {
      operation = await this.advance(operation, "EXTERNAL_CONTACTED", "UNKNOWN");
    } catch {
      await this.settleBeforeTurnStartFailure(operation, attempts, previousAttempt, "CONTINUATION_CONTACT_STATE_PERSIST_FAILED");
      throw localStateFailure();
    }

    let turnStartInvoked = false;
    try {
      return await this.appServer.withNotificationDeliveryBarrier(async () => {
        turnStartInvoked = true;
        let started;
        try {
          started = await this.appServer.startTurn({ prepared, instruction: input.instruction });
        } catch (error) {
          if (error instanceof CodexAppServerTurnStartError && error.effect_state === "not_started") {
            operation = await this.fail(operation, "FAILED_KNOWN_AFTER_CONTACT", "ABSENT", "RUNNER_PROVIDER_FAILED");
            try {
              await restoreAttempt(attempts, previousAttempt);
            } catch {
              throw localStateFailure();
            }
            throw new RepoReaderError(
              "RUNNER_PROVIDER_FAILED",
              "Codex App Server rejected turn start before any turn was created."
            );
          }
          await this.markUnknown(operation, "TURN_START_EFFECT_UNKNOWN");
          throw unknownEffect(input.operation_id);
        }

        let nextStatus: AgentRunnerStatus;
        try {
          await interactions.writeSession({
            repo_id: session.repo_id,
            run_id: session.run_id,
            provider: session.provider,
            thread_id: session.thread_id,
            model: session.model,
            turn_index: turnIndex,
            ...(session.max_runtime_ms === undefined ? {} : { max_runtime_ms: session.max_runtime_ms }),
            active_runtime_ms: session.active_runtime_ms,
            last_consumed_reply_turn_index: session.last_consumed_reply_turn_index,
            created_at: session.created_at
          });
          await attempts.write({
            repo_id: input.repo_id,
            run_id: input.run_id,
            provider: "codex_app_server",
            operation: "resume",
            turn_index: turnIndex,
            state: "in_flight",
            app_server_turn_id: started.app_server_turn_id,
            ...(resultSha256Before === undefined ? {} : { result_sha256_before: resultSha256Before }),
            active_runtime_ms_before: session.active_runtime_ms,
            started_at: startedAt
          });
          await runs.appendEvent({
            repo_id: input.repo_id,
            run_id: input.run_id,
            event_type: "thread_resumed",
            summary: "Continuation turn accepted by the bound Codex thread."
          });
          nextStatus = await runs.writeStatus({
            ...status,
            status: "running",
            revision: status.revision + 1,
            started_at: status.started_at ?? startedAt,
            completed_at: null,
            updated_at: this.now().toISOString(),
            result_found: false,
            head_after: null,
            worktree_fingerprint_after: null,
            changed_paths: [],
            validation: { status: "missing", profile: null, artifact_path: null },
            commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
            review: undefined,
            warnings: [...status.warnings.filter((warning) => warning !== "AGENT_RUN_CONTINUED"), "AGENT_RUN_CONTINUED"]
          });
          operation = await this.advance(operation, "EXTERNAL_SUCCEEDED", "PRESENT", input.repo_id);
          this.appServer.bindAcceptedTurn({
            repo_id: input.repo_id,
            run_id: input.run_id,
            thread_id: session.thread_id,
            app_server_turn_id: started.app_server_turn_id,
            turn_index: turnIndex
          });
        } catch {
          await this.markUnknown(operation, "CONTINUATION_STATE_PERSIST_FAILED");
          throw unknownEffect(input.operation_id);
        }

        return AgentContinuationResultSchema.parse({
          ok: true,
          repo_id: input.repo_id,
          run_id: input.run_id,
          operation_id: input.operation_id,
          accepted: true,
          turn_index: turnIndex,
          revision: nextStatus.revision,
          next_tool_payloads: {
            repo_agent_runs: {
              repo_id: input.repo_id,
              run_id: input.run_id,
              wait_after_revision: nextStatus.revision
            }
          },
          warnings: []
        });
      });
    } catch (error) {
      if (!turnStartInvoked) {
        await this.settleBeforeTurnStartFailure(operation, attempts, previousAttempt, "NOTIFICATION_BARRIER_FAILED");
        throw localStateFailure();
      }
      if (error instanceof RepoReaderError) throw error;
      throw unknownEffect(input.operation_id);
    }
  }

  private async settleBeforeTurnStartFailure(
    operation: OperationState,
    attempts: DelegationAttemptStore,
    previousAttempt: AgentRunnerAttempt,
    code: string
  ): Promise<void> {
    const observed = await this.tasks.states.readOperation(operation.task_id, operation.operation_id);
    if (!observed) throw localStateFailure();
    if (observed.phase === "EXTERNAL_CONTACTED") {
      await this.fail(observed, "FAILED_KNOWN_AFTER_CONTACT", "ABSENT", code);
    } else if (observed.phase === "EXTERNAL_PRECONTACT" || observed.phase === "ADMITTED") {
      await this.fail(observed, "FAILED_PRECONTACT", "NOT_STARTED", code);
    } else {
      throw localStateFailure();
    }
    await restoreAttempt(attempts, previousAttempt);
  }

  private async markUnknown(operation: OperationState, code: string): Promise<void> {
    try {
      await this.fail(operation, "UNKNOWN_AFTER_CONTACT", "UNKNOWN", code);
    } catch {
      // EXTERNAL_CONTACTED and the durable in-flight attempt still prohibit replay.
    }
  }

  private async ensureOperation(input: AgentContinuationInput, taskId: string): Promise<OperationState> {
    const requestSha256 = canonicalSha256({ schema_version: 1, kind: "AGENT_CONTINUE", request: input });
    const existing = await this.tasks.states.readOperation(taskId, input.operation_id);
    if (existing) {
      if (existing.kind !== "AGENT_CONTINUE" || existing.request_sha256 !== requestSha256) {
        throw new RepoReaderError(
          "TASK_OPERATION_CONFLICT",
          "operation_id is already bound to a different task operation."
        );
      }
      return existing;
    }
    const timestamp = this.now().toISOString();
    return this.tasks.states.writeOperation({
      schema_version: 1,
      task_id: taskId,
      operation_id: input.operation_id,
      kind: "AGENT_CONTINUE",
      request_sha256: requestSha256,
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

  private async advance(
    operation: OperationState,
    phase: OperationPhase,
    effectState: ObservedEffectState,
    resultRepoId?: string
  ): Promise<OperationState> {
    const completed = phase === "EXTERNAL_SUCCEEDED";
    const timestamp = this.now().toISOString();
    return this.tasks.states.writeOperation({
      ...operation,
      phase,
      effect_state: effectState,
      revision: operation.revision + 1,
      updated_at: timestamp,
      completed_at: completed ? timestamp : null,
      result_repo_id: resultRepoId ?? operation.result_repo_id,
      error_code: null,
      error_message: null
    });
  }

  private async fail(
    operation: OperationState,
    phase: "FAILED_PRECONTACT" | "FAILED_KNOWN_AFTER_CONTACT" | "UNKNOWN_AFTER_CONTACT",
    effectState: "NOT_STARTED" | "ABSENT" | "UNKNOWN",
    code: string
  ): Promise<OperationState> {
    const timestamp = this.now().toISOString();
    return this.tasks.states.writeOperation({
      ...operation,
      phase,
      effect_state: effectState,
      revision: operation.revision + 1,
      updated_at: timestamp,
      completed_at: timestamp,
      error_code: code.slice(0, 100),
      error_message: phase === "UNKNOWN_AFTER_CONTACT"
        ? "Turn start may have taken effect; automatic replay is forbidden."
        : phase === "FAILED_KNOWN_AFTER_CONTACT"
          ? "Codex App Server confirmed that no turn was created."
          : "Agent continuation stopped before turn start.",
      result_repo_id: operation.result_repo_id
    });
  }
}

function existingOperationError(operation: OperationState, input: AgentContinuationInput): RepoReaderError {
  const diagnostics = { operation_id: input.operation_id, phase: operation.phase };
  if (operation.phase === "EXTERNAL_SUCCEEDED") {
    return new RepoReaderError(
      "TASK_OPERATION_ALREADY_COMPLETED",
      "Agent continuation already completed; the stored operation prevents a second turn start.",
      { diagnostics }
    );
  }
  return new RepoReaderError(
    "TASK_OPERATION_BLOCKED",
    "Agent continuation has a durable incomplete or terminal disposition and will not be replayed automatically.",
    { diagnostics }
  );
}

function stablePrecontactCode(error: unknown): string {
  if (error instanceof RepoReaderError && /^[A-Z0-9_]{1,100}$/.test(error.code)) return error.code;
  return "AGENT_CONTINUATION_PREFLIGHT_FAILED";
}

function publicPrecontactError(error: unknown): RepoReaderError {
  if (error instanceof RepoReaderError) return error;
  return new RepoReaderError(
    "TASK_STATE_MISMATCH",
    "Agent continuation could not validate current private runtime state before turn start."
  );
}

function unknownEffect(operationId: string): RepoReaderError {
  return new RepoReaderError(
    "EXTERNAL_EFFECT_UNKNOWN",
    "Turn start may have taken effect; inspect the same run and do not resend the instruction.",
    { diagnostics: { operation_id: operationId, no_replay: true } }
  );
}

async function restoreAttempt(
  attempts: DelegationAttemptStore,
  previousAttempt: AgentRunnerAttempt
): Promise<void> {
  await attempts.write({
    repo_id: previousAttempt.repo_id,
    run_id: previousAttempt.run_id,
    provider: previousAttempt.provider,
    operation: previousAttempt.operation,
    turn_index: previousAttempt.turn_index,
    state: previousAttempt.state,
    ...(previousAttempt.app_server_turn_id === undefined
      ? {}
      : { app_server_turn_id: previousAttempt.app_server_turn_id }),
    ...(previousAttempt.result_sha256_before === undefined
      ? {}
      : { result_sha256_before: previousAttempt.result_sha256_before }),
    ...(previousAttempt.active_runtime_ms_before === undefined
      ? {}
      : { active_runtime_ms_before: previousAttempt.active_runtime_ms_before }),
    ...(previousAttempt.awaiting_input_ms === undefined
      ? {}
      : { awaiting_input_ms: previousAttempt.awaiting_input_ms }),
    ...(previousAttempt.awaiting_input_started_at === undefined
      ? {}
      : { awaiting_input_started_at: previousAttempt.awaiting_input_started_at }),
    started_at: previousAttempt.started_at,
    updated_at: previousAttempt.updated_at
  });
}

function localStateFailure(): RepoReaderError {
  return new RepoReaderError(
    "RUNNER_INTERACTION_INVALID",
    "Continuation stopped before turn start because durable local state could not be settled."
  );
}
