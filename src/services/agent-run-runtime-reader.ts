import { DelegationAttemptStore } from "../delegation/attempt-store.js";
import { DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS, type AgentRunnerStatus } from "../delegation/artifact-contracts.js";
import { DelegationInteractionStore } from "../delegation/interaction-store.js";
import type { DelegationRunRecord } from "../delegation/run-store.js";
import { describeAgentRuntimeBudget, type DelegationRuntimeBudget } from "../delegation/runtime-budget.js";

export type AgentRunRuntimeReaderOptions = {
  repository_max_runtime_ms?: number;
  now?: () => Date;
};

export class AgentRunRuntimeReader {
  private readonly attempts: DelegationAttemptStore;
  private readonly interactions: DelegationInteractionStore;
  private readonly repositoryMaxRuntimeMs: number;
  private readonly now: () => Date;

  constructor(root: string, options: AgentRunRuntimeReaderOptions = {}) {
    this.attempts = new DelegationAttemptStore(root);
    this.interactions = new DelegationInteractionStore(root);
    this.repositoryMaxRuntimeMs = options.repository_max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS;
    this.now = options.now ?? (() => new Date());
  }

  async read(
    record: DelegationRunRecord,
    status: AgentRunnerStatus | undefined,
    warnings: string[]
  ): Promise<DelegationRuntimeBudget> {
    let activeRuntimeMs = 0;
    let persistedMaxRuntimeMs: number | undefined;
    let sessionFound = false;
    try {
      const session = await this.interactions.readSession(record.repo_id, record.run_id);
      sessionFound = session !== undefined;
      activeRuntimeMs = session?.active_runtime_ms ?? 0;
      persistedMaxRuntimeMs = session?.max_runtime_ms;
    } catch {
      warnings.push("AGENT_RUN_RUNTIME_INVALID");
    }

    const effectiveStatus = status?.status ?? record.runner.mode;
    try {
      const attempt = await this.attempts.read(record.repo_id, record.run_id);
      const expectedProvider = status?.runner ?? record.runner.requested_runner;
      if (attempt && attempt.provider === expectedProvider) {
        if (attempt.state === "in_flight" && !["claimed", "running", "awaiting_input"].includes(effectiveStatus)) {
          warnings.push("AGENT_RUN_EFFECT_UNKNOWN_NO_REPLAY");
        }
        if (attempt.state === "in_flight" && ["claimed", "running", "awaiting_input"].includes(effectiveStatus)) {
          const elapsed = activeElapsedMs(attempt, this.now().getTime());
          const provisional = describeAgentRuntimeBudget(
            this.repositoryMaxRuntimeMs,
            record.runner.max_runtime_ms,
            activeRuntimeMs,
            persistedMaxRuntimeMs
          );
          activeRuntimeMs += Math.min(elapsed, provisional.remaining_runtime_ms);
        } else if (attempt.state === "settled" && !sessionFound) {
          activeRuntimeMs += activeElapsedMs(attempt, Date.parse(attempt.updated_at));
        }
      } else if (attempt) {
        warnings.push("AGENT_RUN_RUNTIME_INVALID");
      }
    } catch {
      warnings.push("AGENT_RUN_RUNTIME_INVALID");
    }

    if (
      record.runner.max_runtime_ms !== undefined
      && record.runner.max_runtime_ms > this.repositoryMaxRuntimeMs
    ) warnings.push("AGENT_RUN_RUNTIME_CLAMPED");

    return describeAgentRuntimeBudget(
      this.repositoryMaxRuntimeMs,
      record.runner.max_runtime_ms,
      activeRuntimeMs,
      persistedMaxRuntimeMs
    );
  }
}

function elapsedMs(startedAt: string, endedAt: number): number {
  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAtMs)
    : 0;
}

function activeElapsedMs(
  attempt: {
    started_at: string;
    awaiting_input_ms?: number;
    awaiting_input_started_at?: string;
  },
  endedAt: number
): number {
  const elapsed = elapsedMs(attempt.started_at, endedAt);
  const openPause = attempt.awaiting_input_started_at === undefined
    ? 0
    : elapsedMs(attempt.awaiting_input_started_at, endedAt);
  const paused = Math.min(elapsed, (attempt.awaiting_input_ms ?? 0) + openPause);
  return elapsed - paused;
}
