import { canonicalSha256, type TaskRuntimeService } from "../task-runtime/index.js";
import { DelegationAttemptStore } from "../delegation/attempt-store.js";
import {
  CodexAppServerAdapter,
  CodexAppServerThreadStartError,
  CodexAppServerTurnStartError,
  type ManagedCodexAppServerTurnBinding
} from "../delegation/codex-app-server-adapter.js";
import {
  CodexAppServerControlRpc,
  type CodexAppServerControlRpcOptions
} from "../delegation/codex-app-server-control-rpc.js";
import { CodexAppServerRunSink } from "../delegation/codex-app-server-run-sink.js";
import { DelegationDispatchStore } from "../delegation/dispatch-store.js";
import { DelegationInteractionStore } from "../delegation/interaction-store.js";
import type { WorkerLaunchOutcome } from "../delegation/execution-runtime-contracts.js";
import type { BoundedWorkerLauncher } from "../delegation/queue-supervisor.js";
import { DelegationRunStore, type DelegationRunRecord } from "../delegation/run-store.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { RepoReaderError } from "../runtime/errors.js";
import { GitService } from "./git-service.js";
import { reviewRequirementForDelegationTaskV3 } from "./delegation-v3-normalizer.js";
import { sha256Text } from "./codex-task-policy.js";
import type { RootRegistry, TaskRepoBinding } from "./root-registry.js";

const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked_policy", "blocked_verification", "timed_out", "canceled", "committed"]);

export type InitialRunnerConnection = {
  adapter: CodexAppServerAdapter;
  close(): Promise<void>;
};

export type CodexAppServerInitialRunnerOptions = {
  now?: () => Date;
  connection_factory?: () => InitialRunnerConnection;
  rpc_options?: CodexAppServerControlRpcOptions;
};

export type CodexAppServerReconciliationResult = {
  examined: number;
  rebound: number;
  settled: number;
  failed_closed: number;
};

type ActiveInitialConnection = {
  connection: InitialRunnerConnection;
  binding: ManagedCodexAppServerTurnBinding;
};

/**
 * Owner-local initial-run executor for the existing durable delegation queue.
 *
 * It exposes no network endpoint or public MCP tool. One admitted launch creates
 * one App Server thread and one turn, then retains only the originating local
 * connection needed for approvals, structured input, and terminal settlement.
 */
export class CodexAppServerInitialRunner implements BoundedWorkerLauncher {
  private readonly now: () => Date;
  private readonly connectionFactory: () => InitialRunnerConnection;
  private readonly activeConnections = new Map<string, ActiveInitialConnection>();

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    options: CodexAppServerInitialRunnerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.connectionFactory = options.connection_factory ?? (() => {
      const sink = new CodexAppServerRunSink(this.registry, this.tasks, { now: this.now });
      const rpc = new CodexAppServerControlRpc(sink, options.rpc_options);
      return { adapter: new CodexAppServerAdapter(rpc), close: () => rpc.close() };
    });
  }

  async launch(input: Parameters<BoundedWorkerLauncher["launch"]>[0]): Promise<WorkerLaunchOutcome> {
    let connection: InitialRunnerConnection | undefined;
    let contactAttempted = false;
    let threadStartConfirmed = false;
    let turnStartInvoked = false;
    let acceptedBinding: ManagedCodexAppServerTurnBinding | undefined;
    const key = runKey(input.run.repo_id, input.run.run_id);
    try {
      return await this.withRunLock(input.run.repo_id, input.run.run_id, async (task) => {
        const root = this.registry.get(input.run.repo_id).root;
        if (input.run.manifest.schema_version !== 3) {
          throw new RepoReaderError("TASK_STATE_MISMATCH", "Initial managed execution requires a Delegation v3 run.");
        }
        const manifest = input.run.manifest;
        const runs = new DelegationRunStore(root, { now: this.now });
        const attempts = new DelegationAttemptStore(root, this.now);
        const interactions = new DelegationInteractionStore(root, this.now);
        const [prompt, existingStatus, existingAttempt, existingSession, existingResult] = await Promise.all([
          readSafeRunArtifact(root, input.run.prompt_path, MAX_PROMPT_BYTES),
          runs.readStatus(input.run.run_id),
          attempts.read(input.run.repo_id, input.run.run_id),
          interactions.readSession(input.run.repo_id, input.run.run_id),
          readSafeRunArtifact(root, input.run.result_json_path, MAX_PROMPT_BYTES)
        ]);
        await this.assertLaunchBinding(input, task, prompt);
        if (existingStatus || existingAttempt || existingSession || existingResult !== undefined) {
          throw new RepoReaderError(
            "TASK_OPERATION_CONFLICT",
            "Initial managed launch requires an unstarted run with no status, session, attempt, or result artifact."
          );
        }

        const git = new GitService(root);
        const [gitStatus, worktreeFingerprint] = await Promise.all([git.status(), git.worktreeFingerprint()]);
        if (
          gitStatus.head_sha !== input.dispatch.task_binding.head_sha
          || worktreeFingerprint !== manifest.baseline.worktree_fingerprint
        ) {
          throw new RepoReaderError(
            "TASK_STATE_MISMATCH",
            "The task repository changed after queue admission; initial launch was not started."
          );
        }
        const startedAt = this.now().toISOString();
        await runs.writeStatus({
          ...statusBinding(input.run),
          repo_id: input.run.repo_id,
          run_id: input.run.run_id,
          runner: "codex_app_server",
          status: "claimed",
          revision: 0,
          started_at: startedAt,
          completed_at: null,
          result_found: false,
          head_before: gitStatus.head_sha,
          head_after: null,
          worktree_fingerprint_before: worktreeFingerprint,
          worktree_fingerprint_after: null,
          changed_paths: [],
          validation: { status: "missing", profile: null, artifact_path: null },
          commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
          warnings: []
        });
        await runs.appendEvent({
          repo_id: input.run.repo_id,
          run_id: input.run.run_id,
          event_type: "claimed",
          summary: "The owner-local Codex App Server runner claimed the exact admitted run."
        });

        try {
          connection = this.connectionFactory();
        } catch {
          await failStatus(runs, input.run, "APP_SERVER_INITIAL_PRECONTACT_FAILED", this.now);
          return knownFailure("APP_SERVER_INITIAL_PRECONTACT_FAILED", false);
        }
        try {
          return await connection.adapter.withNotificationDeliveryBarrier(async () => {
            let prepared;
            try {
              contactAttempted = true;
              prepared = await connection!.adapter.startThread({ repo_root: root });
              threadStartConfirmed = true;
            } catch (error) {
              if (error instanceof CodexAppServerThreadStartError && error.effect_state === "request_not_sent") {
                await failStatus(runs, input.run, "APP_SERVER_THREAD_START_NOT_SENT", this.now);
                return knownFailure("APP_SERVER_THREAD_START_NOT_SENT", true);
              }
              if (error instanceof CodexAppServerThreadStartError && error.effect_state === "not_started") {
                await failStatus(runs, input.run, "APP_SERVER_THREAD_START_REJECTED", this.now);
                return knownFailure("APP_SERVER_THREAD_START_REJECTED", true);
              }
              await blockUnknownStatus(runs, input.run, "APP_SERVER_THREAD_START_EFFECT_UNKNOWN", this.now);
              return unknownOutcome("APP_SERVER_THREAD_START_EFFECT_UNKNOWN");
            }

            await interactions.writeSession({
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              provider: "codex_app_server",
              thread_id: prepared.thread_id,
              model: prepared.model,
              turn_index: 1,
              max_runtime_ms: input.max_runtime_ms,
              active_runtime_ms: 0,
              last_consumed_reply_turn_index: null,
              created_at: startedAt
            });
            await attempts.write({
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              provider: "codex_app_server",
              operation: "start",
              turn_index: 1,
              state: "in_flight",
              active_runtime_ms_before: 0,
              started_at: startedAt
            });
            await runs.appendEvent({
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              event_type: "thread_started",
              summary: "Codex App Server created the exact owner-local thread for this run."
            });
            await runs.writeStatus({
              ...(await requiredStatus(runs, input.run.run_id)),
              status: "running",
              revision: 1,
              completed_at: null,
              updated_at: this.now().toISOString()
            });

            let started;
            try {
              turnStartInvoked = true;
              started = await connection!.adapter.startTurn({ prepared, instruction: prompt! });
            } catch (error) {
              if (error instanceof CodexAppServerTurnStartError && error.effect_state === "not_started") {
                await failStatus(runs, input.run, "APP_SERVER_TURN_START_REJECTED", this.now);
                await settleAttemptWithoutTurn(attempts, input.run, startedAt);
                return knownFailure("APP_SERVER_TURN_START_REJECTED", true);
              }
              await blockUnknownStatus(runs, input.run, "APP_SERVER_TURN_START_EFFECT_UNKNOWN", this.now);
              return unknownOutcome("APP_SERVER_TURN_START_EFFECT_UNKNOWN");
            }

            const binding = {
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              thread_id: prepared.thread_id,
              app_server_turn_id: started.app_server_turn_id,
              turn_index: 1
            } satisfies ManagedCodexAppServerTurnBinding;
            await attempts.write({
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              provider: "codex_app_server",
              operation: "start",
              turn_index: 1,
              state: "in_flight",
              app_server_turn_id: started.app_server_turn_id,
              active_runtime_ms_before: 0,
              started_at: startedAt
            });
            connection!.adapter.bindAcceptedTurn(binding);
            acceptedBinding = binding;
            this.activeConnections.set(key, { connection: connection!, binding });
            await runs.appendEvent({
              repo_id: input.run.repo_id,
              run_id: input.run.run_id,
              event_type: "started",
              summary: "Codex App Server accepted the exact initial managed turn."
            });
            return {
              effect_state: "known_complete",
              provider_contact: "confirmed",
              terminal_state: "unknown",
              outcome_code: "APP_SERVER_INITIAL_TURN_ACCEPTED"
            } satisfies WorkerLaunchOutcome;
          });
        } catch {
          if (threadStartConfirmed && !turnStartInvoked) {
            await failStatus(runs, input.run, "APP_SERVER_INITIAL_STATE_PERSIST_FAILED", this.now).catch(() => undefined);
            return knownFailure("APP_SERVER_INITIAL_STATE_PERSIST_FAILED", true);
          }
          if (contactAttempted) {
            await blockUnknownStatus(runs, input.run, "APP_SERVER_INITIAL_LAUNCH_BOUNDARY_UNKNOWN", this.now).catch(() => undefined);
            return unknownOutcome("APP_SERVER_INITIAL_LAUNCH_BOUNDARY_UNKNOWN");
          }
          await failStatus(runs, input.run, "APP_SERVER_INITIAL_PRECONTACT_FAILED", this.now).catch(() => undefined);
          return knownFailure("APP_SERVER_INITIAL_PRECONTACT_FAILED", false);
        }
      });
    } catch {
      return contactAttempted
        ? unknownOutcome("APP_SERVER_INITIAL_LAUNCH_BOUNDARY_UNKNOWN")
        : knownFailure("APP_SERVER_INITIAL_PRECONTACT_FAILED", false);
    } finally {
      if (connection && !acceptedBinding) await connection.close().catch(() => undefined);
    }
  }

  async reconcileRepository(repoId: string): Promise<CodexAppServerReconciliationResult> {
    const root = this.registry.get(repoId).root;
    const runs = new DelegationRunStore(root, { now: this.now });
    const attempts = new DelegationAttemptStore(root, this.now);
    const interactions = new DelegationInteractionStore(root, this.now);
    const records = await runs.discoverRuns();
    const result: CodexAppServerReconciliationResult = { examined: 0, rebound: 0, settled: 0, failed_closed: 0 };
    for (const run of records) {
      if (run.repo_id !== repoId || run.runner.requested_runner !== "codex_app_server") continue;
      const status = await runs.readStatus(run.run_id);
      const key = runKey(repoId, run.run_id);
      if (!status || TERMINAL_STATUSES.has(status.status)) {
        const active = this.activeConnections.get(key);
        if (active) {
          this.activeConnections.delete(key);
          await active.connection.close().catch(() => undefined);
        }
        continue;
      }
      if (status.status !== "running" && status.status !== "awaiting_input") continue;
      result.examined += 1;
      const [attempt, session] = await Promise.all([
        attempts.read(repoId, run.run_id),
        interactions.readSession(repoId, run.run_id)
      ]);
      const ownsInitialTurn = Boolean(
        attempt
        && attempt.operation === "start"
        && attempt.turn_index === 1
        && attempt.state === "in_flight"
        && attempt.app_server_turn_id
        && session
        && session.provider === "codex_app_server"
        && session.turn_index === 1
      );
      const active = this.activeConnections.get(key);
      if (active) {
        if (
          ownsInitialTurn
          && session
          && attempt?.app_server_turn_id
          && active.binding.thread_id === session.thread_id
          && active.binding.app_server_turn_id === attempt.app_server_turn_id
          && active.binding.turn_index === 1
        ) {
          continue;
        }
        this.activeConnections.delete(key);
        await active.connection.close().catch(() => undefined);
        if (!ownsInitialTurn) continue;
        result.failed_closed += 1;
        continue;
      }
      if (!ownsInitialTurn || !attempt?.app_server_turn_id || !session) continue;
      const connection = this.connectionFactory();
      const binding: ManagedCodexAppServerTurnBinding = {
        repo_id: repoId,
        run_id: run.run_id,
        thread_id: session.thread_id,
        app_server_turn_id: attempt.app_server_turn_id,
        turn_index: attempt.turn_index
      };
      try {
        const turnStatus = await connection.adapter.reconcileTurn({ binding, repo_root: root });
        if (turnStatus === "inProgress") {
          await repairLaunchResult(root, run, "unknown", this.now);
          this.activeConnections.set(key, { connection, binding });
          result.rebound += 1;
        } else {
          await waitForTerminalStatus(runs, run.run_id);
          const settledStatus = await runs.readStatus(run.run_id);
          await repairLaunchResult(
            root,
            run,
            settledStatus?.status === "completed"
              ? "completed"
              : settledStatus?.status === "blocked_policy" || settledStatus?.status === "blocked_verification"
                ? "blocked"
                : "failed",
            this.now
          );
          await connection.close();
          result.settled += 1;
        }
      } catch {
        result.failed_closed += 1;
        await connection.close().catch(() => undefined);
      }
    }
    return result;
  }

  async close(): Promise<void> {
    const connections = [...this.activeConnections.values()].map(({ connection }) => connection);
    this.activeConnections.clear();
    await Promise.all(connections.map((connection) => connection.close().catch(() => undefined)));
  }

  private async assertLaunchBinding(
    input: Parameters<BoundedWorkerLauncher["launch"]>[0],
    task: TaskRepoBinding,
    prompt: string | undefined
  ): Promise<void> {
    if (
      input.dispatch.repo_id !== input.run.repo_id
      || input.dispatch.run_id !== input.run.run_id
      || input.dispatch.runner !== "codex_app_server"
      || input.run.runner.requested_runner !== "codex_app_server"
      || input.dispatch.task_binding.task_id !== task.task_id
      || input.dispatch.task_binding.task_repo_id !== task.task_repo_id
      || input.dispatch.delegation_binding.manifest_canonical_sha256 !== canonicalSha256(input.run.manifest)
      || input.run.manifest.schema_version !== 3
      || input.dispatch.delegation_binding.task_sha256 !== input.run.manifest.task_sha256
      || input.dispatch.delegation_binding.baseline_sha256 !== input.run.manifest.baseline_sha256
      || input.dispatch.delegation_binding.prompt_sha256 !== input.run.manifest.prompt_sha256
      || prompt === undefined
      || sha256Text(prompt) !== input.run.manifest.prompt_sha256
    ) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "The admitted initial-run binding changed before launch.");
    }
    const persistedTask = (await this.tasks.listTasks({ limit: 10_000 }))
      .find((candidate) => candidate.task_id === task.task_id);
    if (
      !persistedTask
      || persistedTask.repo_id !== task.task_repo_id
      || persistedTask.lifecycle !== "OPEN"
      || persistedTask.registration_state !== "REGISTERED"
      || persistedTask.worktree_head !== input.dispatch.task_binding.head_sha
      || persistedTask.worktree_tree !== input.dispatch.task_binding.tree_sha
    ) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "The task HEAD or tree changed before initial launch.");
    }
  }

  private withRunLock<T>(
    repoId: string,
    runId: string,
    action: (task: TaskRepoBinding) => Promise<T>
  ): Promise<T> {
    const repo = this.registry.get(repoId);
    if (!repo.task || repo.task.authority === "inspect") {
      throw new RepoReaderError("LIFECYCLE_POLICY_DENIED", "Initial managed execution requires an implement or ship task repository.");
    }
    return this.tasks.locks.withLock(`task:${repo.task.task_id}`, async () =>
      this.tasks.locks.withLock(`agent-run:${repo.task!.task_id}:${runId}`, () => action(repo.task!))
    );
  }
}

function statusBinding(run: DelegationRunRecord) {
  if (run.manifest.schema_version !== 3) throw new Error("Delegation v3 is required.");
  return {
    manifest_version: 3 as const,
    review_requirement: reviewRequirementForDelegationTaskV3(run.manifest.task),
    prompt_path: run.prompt_path,
    result_json_path: run.result_json_path
  };
}

async function requiredStatus(runs: DelegationRunStore, runId: string) {
  const status = await runs.readStatus(runId);
  if (!status) throw new Error("Managed runner status disappeared.");
  return status;
}

async function failStatus(
  runs: DelegationRunStore,
  run: DelegationRunRecord,
  warning: string,
  now: () => Date
): Promise<void> {
  const status = await runs.readStatus(run.run_id);
  if (!status || TERMINAL_STATUSES.has(status.status)) return;
  const completedAt = now().toISOString();
  await runs.writeStatus({
    ...status,
    status: "failed",
    revision: status.revision + 1,
    completed_at: completedAt,
    updated_at: completedAt,
    warnings: [...new Set([...status.warnings, warning])]
  });
  await runs.appendEvent({ repo_id: run.repo_id, run_id: run.run_id, event_type: "failed", summary: warning });
}

async function blockUnknownStatus(
  runs: DelegationRunStore,
  run: DelegationRunRecord,
  warning: string,
  now: () => Date
): Promise<void> {
  const status = await runs.readStatus(run.run_id);
  if (!status || TERMINAL_STATUSES.has(status.status)) return;
  const completedAt = now().toISOString();
  await runs.writeStatus({
    ...status,
    status: "blocked_policy",
    revision: status.revision + 1,
    completed_at: completedAt,
    updated_at: completedAt,
    warnings: [...new Set([...status.warnings, warning, "UNKNOWN_EFFECT_NO_REPLAY"])]
  });
  await runs.appendEvent({
    repo_id: run.repo_id,
    run_id: run.run_id,
    event_type: "policy_blocked",
    summary: "The initial App Server effect is unknown and will not be replayed."
  });
}

async function settleAttemptWithoutTurn(
  attempts: DelegationAttemptStore,
  run: DelegationRunRecord,
  startedAt: string
): Promise<void> {
  await attempts.write({
    repo_id: run.repo_id,
    run_id: run.run_id,
    provider: "codex_app_server",
    operation: "start",
    turn_index: 1,
    state: "settled",
    active_runtime_ms_before: 0,
    started_at: startedAt
  });
}

function knownFailure(outcomeCode: string, contacted: boolean): WorkerLaunchOutcome {
  return {
    effect_state: "known_failed",
    provider_contact: contacted ? "confirmed" : "none",
    terminal_state: "failed",
    outcome_code: outcomeCode
  };
}

function unknownOutcome(outcomeCode: string): WorkerLaunchOutcome {
  return {
    effect_state: "unknown",
    provider_contact: "unknown",
    terminal_state: "unknown",
    outcome_code: outcomeCode
  };
}

async function repairLaunchResult(
  root: string,
  run: DelegationRunRecord,
  terminalState: "completed" | "blocked" | "failed" | "unknown",
  now: () => Date
): Promise<void> {
  const dispatches = new DelegationDispatchStore(root, now);
  const [dispatch, intent, result] = await Promise.all([
    dispatches.readDispatch(run.run_id),
    dispatches.readIntent(run.run_id),
    dispatches.readResult(run.run_id)
  ]);
  if (!dispatch || !intent || result) return;
  await dispatches.writeLaunchResult({
    dispatch,
    started_at: intent.requested_at,
    outcome: {
      effect_state: "known_complete",
      provider_contact: "confirmed",
      terminal_state: terminalState,
      outcome_code: "APP_SERVER_INITIAL_TURN_RECONCILED"
    }
  });
}

async function waitForTerminalStatus(runs: DelegationRunStore, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await runs.readStatus(runId);
    if (status && TERMINAL_STATUSES.has(status.status)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Reconciled terminal notification did not settle the local run in time.");
}

function runKey(repoId: string, runId: string): string {
  return `${repoId}\0${runId}`;
}
