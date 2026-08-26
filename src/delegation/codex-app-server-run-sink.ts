import { z } from "zod";
import {
  DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
  type AgentRunnerAttempt,
  type AgentRunnerStatus,
  type AgentTurnQuestion
} from "./artifact-contracts.js";
import { DelegationAttemptStore } from "./attempt-store.js";
import { DelegationInteractionStore } from "./interaction-store.js";
import { DelegationRunStore } from "./run-store.js";
import { readSafeRunArtifact } from "./safe-artifact.js";
import type { ManagedCodexAppServerTurnBinding } from "./codex-app-server-adapter.js";
import type {
  CodexAppServerEventSink,
  CodexAppServerNotification,
  CodexAppServerServerRequest,
  CodexAppServerServerRequestDisposition
} from "./codex-app-server-control-rpc.js";
import { canonicalSha256, type TaskRuntimeService } from "../task-runtime/index.js";
import type { RootRegistry, TaskRepoBinding } from "../services/root-registry.js";
import { parseStructuredCodexResult } from "../services/codex-result-parser.js";
import { GitService } from "../services/git-service.js";

const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const REPLY_POLL_MS = 100;

const RequestUserInputParamsSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turnId: z.string().min(1).max(1_024),
  itemId: z.string().min(1).max(1_024),
  isBlocking: z.boolean().default(true),
  questions: z.array(z.object({
    id: z.string().min(1).max(256),
    header: z.string().min(1).max(256),
    question: z.string().min(1).max(2_000),
    isOther: z.boolean().default(false),
    isSecret: z.boolean().default(false),
    options: z.array(z.object({
      label: z.string().min(1).max(500),
      description: z.string().max(1_000)
    }).passthrough()).max(8).nullable().optional()
  }).passthrough()).min(1).max(3)
}).passthrough();

const TurnCompletedParamsSchema = z.object({
  turn: z.object({
    id: z.string().min(1).max(1_024),
    status: z.enum(["completed", "interrupted", "failed"])
  }).passthrough()
}).passthrough();

type PendingQuestionRequest = {
  controller: AbortController;
  turn_id: string;
  binding: ManagedCodexAppServerTurnBinding;
};

type QuestionMapping = {
  original_id: string;
  public_question: AgentTurnQuestion;
};

export type CodexAppServerRunSinkOptions = {
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Owner-side settlement for turns started by the continuation bridge.
 * Public observation remains runner.status.json through repo_agent_runs; this
 * sink only advances the existing private session/attempt and status artifacts.
 */
export class CodexAppServerRunSink implements CodexAppServerEventSink {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly bindings = new Map<string, ManagedCodexAppServerTurnBinding>();
  private readonly pendingQuestions = new Map<string, PendingQuestionRequest>();
  private closed = false;

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    options: CodexAppServerRunSinkOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  }

  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void {
    this.bindings.set(binding.app_server_turn_id, { ...binding });
  }

  async handleNotification(notification: CodexAppServerNotification): Promise<void> {
    if (this.closed) return;
    if (notification.method === "serverRequest/resolved") {
      const requestId = notification.params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const pending = this.pendingQuestions.get(requestKey(requestId));
        if (pending) {
          pending.controller.abort();
          await this.markQuestionResolved(pending.binding);
        }
      }
      return;
    }
    if (notification.method !== "turn/completed") return;
    const completed = TurnCompletedParamsSchema.safeParse(notification.params);
    if (!completed.success) return;
    const binding = this.bindings.get(completed.data.turn.id);
    if (!binding) return;
    this.abortTurnQuestions(binding.app_server_turn_id);
    await this.settleCompletedTurn(binding, completed.data.turn.status);
    this.bindings.delete(binding.app_server_turn_id);
  }

  async handleServerRequest(
    request: CodexAppServerServerRequest
  ): Promise<CodexAppServerServerRequestDisposition> {
    if (this.closed || request.method !== "item/tool/requestUserInput") return { handled: false };
    const parsed = RequestUserInputParamsSchema.safeParse(request.params);
    if (!parsed.success || !parsed.data.isBlocking) return { handled: false };
    const binding = this.bindings.get(parsed.data.turnId);
    if (
      !binding
      || binding.thread_id !== parsed.data.threadId
      || parsed.data.questions.some((question) => question.isSecret)
    ) {
      return { handled: false };
    }
    const key = requestKey(request.id);
    if (this.pendingQuestions.has(key)) return { handled: false };
    const mappings = mapQuestions(parsed.data.questions);
    if (!mappings) return { handled: false };

    const controller = new AbortController();
    this.pendingQuestions.set(key, {
      controller,
      turn_id: binding.app_server_turn_id,
      binding: { ...binding }
    });
    try {
      const questionSha256 = await this.persistAwaitingInput(
        binding,
        mappings.map(({ public_question }) => public_question),
        canonicalSha256({
          method: request.method,
          item_id: parsed.data.itemId,
          thread_id: parsed.data.threadId,
          turn_id: parsed.data.turnId
        })
      );
      if (controller.signal.aborted) {
        await this.markQuestionResolved(binding);
        return { handled: false };
      }
      while (!controller.signal.aborted && !this.closed) {
        const response = await this.consumeReplyIfPresent(binding, mappings, questionSha256);
        if (response) return { handled: true, result: response };
        await this.sleep(REPLY_POLL_MS);
      }
      return { handled: false };
    } finally {
      this.pendingQuestions.delete(key);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pendingQuestions.values()) pending.controller.abort();
    this.pendingQuestions.clear();
    this.bindings.clear();
  }

  private async persistAwaitingInput(
    binding: ManagedCodexAppServerTurnBinding,
    questions: AgentTurnQuestion[],
    requestSha256: string
  ): Promise<string> {
    const { root, task } = this.boundRepo(binding);
    return this.withRunLock(task, binding.run_id, async () => {
      const runs = new DelegationRunStore(root, { now: this.now });
      const attempts = new DelegationAttemptStore(root, this.now);
      const interactions = new DelegationInteractionStore(root, this.now);
      const [status, attempt, session, existingQuestion] = await Promise.all([
        runs.readStatus(binding.run_id),
        attempts.read(binding.repo_id, binding.run_id),
        interactions.readSession(binding.repo_id, binding.run_id),
        interactions.readQuestion(binding.repo_id, binding.run_id, binding.turn_index)
      ]);
      assertActiveBinding(binding, status, attempt, session);
      let questionSha256: string;
      const sameQuestions = existingQuestion !== undefined
        && JSON.stringify(existingQuestion.question.questions) === JSON.stringify(questions);
      const sameManagedRequest = existingQuestion?.question.request_sha256 === requestSha256;
      const legacyPendingEquivalent = existingQuestion?.question.request_sha256 === undefined
        && status!.status === "awaiting_input";
      if (
        existingQuestion
        && sameQuestions
        && (sameManagedRequest || legacyPendingEquivalent)
      ) {
        questionSha256 = existingQuestion.sha256;
      } else {
        if (existingQuestion) {
          const priorReply = await interactions.readReply(
            binding.repo_id,
            binding.run_id,
            binding.turn_index,
            existingQuestion.sha256
          );
          if (status!.status !== "running" || !priorReply) {
            throw new Error("Conflicting managed question replay.");
          }
        }
        questionSha256 = (await interactions.writeQuestion({
          repo_id: binding.repo_id,
          run_id: binding.run_id,
          turn_index: binding.turn_index,
          request_sha256: requestSha256,
          questions
        }, existingQuestion ? { replace_question_sha256: existingQuestion.sha256 } : {})).sha256;
      }
      if (status!.status !== "awaiting_input") {
        if (attempt!.awaiting_input_started_at === undefined) {
          await attempts.write(attemptWriteInput(attempt!, {
            awaiting_input_started_at: this.now().toISOString()
          }));
        }
        await runs.appendEvent({
          repo_id: binding.repo_id,
          run_id: binding.run_id,
          event_type: "input_requested",
          summary: "The managed Codex turn requested structured input."
        });
        await runs.writeStatus({
          ...status!,
          status: "awaiting_input",
          revision: status!.revision + 1,
          completed_at: null,
          updated_at: this.now().toISOString()
        });
      }
      return questionSha256;
    });
  }

  private async consumeReplyIfPresent(
    binding: ManagedCodexAppServerTurnBinding,
    mappings: QuestionMapping[],
    questionSha256: string
  ): Promise<{ answers: Record<string, { answers: string[] }> } | undefined> {
    const { root, task } = this.boundRepo(binding);
    const interactions = new DelegationInteractionStore(root, this.now);
    const reply = await interactions.readReply(
      binding.repo_id,
      binding.run_id,
      binding.turn_index,
      questionSha256
    );
    if (!reply) return undefined;
    return this.withRunLock(task, binding.run_id, async () => {
      const runs = new DelegationRunStore(root, { now: this.now });
      const attempts = new DelegationAttemptStore(root, this.now);
      const currentInteractions = new DelegationInteractionStore(root, this.now);
      const [status, attempt, session, currentReply] = await Promise.all([
        runs.readStatus(binding.run_id),
        attempts.read(binding.repo_id, binding.run_id),
        currentInteractions.readSession(binding.repo_id, binding.run_id),
        currentInteractions.readReply(binding.repo_id, binding.run_id, binding.turn_index, questionSha256)
      ]);
      assertActiveBinding(binding, status, attempt, session);
      if (!currentReply || currentReply.question_sha256 !== questionSha256) {
        throw new Error("Managed reply disappeared or changed.");
      }
      const answers = buildAppServerAnswers(mappings, currentReply.answers);
      if (status!.status === "awaiting_input") {
        if (attempt!.awaiting_input_started_at !== undefined) {
          await attempts.write(resumedAttemptInput(attempt!, this.now()));
        }
        await currentInteractions.writeSession({
          repo_id: session!.repo_id,
          run_id: session!.run_id,
          provider: session!.provider,
          thread_id: session!.thread_id,
          ...(session!.model === undefined ? {} : { model: session!.model }),
          turn_index: session!.turn_index,
          ...(session!.max_runtime_ms === undefined ? {} : { max_runtime_ms: session!.max_runtime_ms }),
          active_runtime_ms: session!.active_runtime_ms,
          last_consumed_reply_turn_index: binding.turn_index,
          created_at: session!.created_at
        });
        await runs.appendEvent({
          repo_id: binding.repo_id,
          run_id: binding.run_id,
          event_type: "input_received",
          summary: "The structured reply was delivered to the active managed Codex turn."
        });
        await runs.writeStatus({
          ...status!,
          status: "running",
          revision: status!.revision + 1,
          completed_at: null,
          updated_at: this.now().toISOString()
        });
      }
      return { answers };
    });
  }

  private async markQuestionResolved(binding: ManagedCodexAppServerTurnBinding): Promise<void> {
    const { root, task } = this.boundRepo(binding);
    await this.withRunLock(task, binding.run_id, async () => {
      const runs = new DelegationRunStore(root, { now: this.now });
      const attempts = new DelegationAttemptStore(root, this.now);
      const interactions = new DelegationInteractionStore(root, this.now);
      const [status, attempt, session] = await Promise.all([
        runs.readStatus(binding.run_id),
        attempts.read(binding.repo_id, binding.run_id),
        interactions.readSession(binding.repo_id, binding.run_id)
      ]);
      if (status?.status !== "awaiting_input") return;
      assertActiveBinding(binding, status, attempt, session);
      if (attempt!.awaiting_input_started_at !== undefined) {
        await attempts.write(resumedAttemptInput(attempt!, this.now()));
      }
      await runs.appendEvent({
        repo_id: binding.repo_id,
        run_id: binding.run_id,
        event_type: "input_received",
        summary: "The structured request was resolved by an owner App Server client."
      });
      await runs.writeStatus({
        ...status,
        status: "running",
        revision: status.revision + 1,
        completed_at: null,
        updated_at: this.now().toISOString()
      });
    });
  }

  private async settleCompletedTurn(
    binding: ManagedCodexAppServerTurnBinding,
    turnStatus: "completed" | "interrupted" | "failed"
  ): Promise<void> {
    const { root, task } = this.boundRepo(binding);
    await this.withRunLock(task, binding.run_id, async () => {
      const runs = new DelegationRunStore(root, { now: this.now });
      const attempts = new DelegationAttemptStore(root, this.now);
      const interactions = new DelegationInteractionStore(root, this.now);
      const [run, status, attempt, session] = await Promise.all([
        runs.readRun(binding.run_id),
        runs.readStatus(binding.run_id),
        attempts.read(binding.repo_id, binding.run_id),
        interactions.readSession(binding.repo_id, binding.run_id)
      ]);
      if (attempt?.state === "settled" && attempt.app_server_turn_id === binding.app_server_turn_id) return;
      assertActiveBinding(binding, status, attempt, session);

      const rawResult = await readSafeRunArtifact(root, run.result_json_path, MAX_RESULT_BYTES);
      const resultSha256 = rawResult === undefined ? undefined : canonicalSha256(rawResult);
      let validFreshResult = Boolean(
        rawResult !== undefined
        && (attempt!.result_sha256_before === undefined || resultSha256 !== attempt!.result_sha256_before)
      );
      let resultStatus: "completed" | "blocked" | undefined;
      let resultChangedPaths: string[] = [];
      if (validFreshResult) {
        try {
          const parsedResult = parseStructuredCodexResult(rawResult!, binding.repo_id, binding.run_id).result;
          if (parsedResult.status !== "completed" && parsedResult.status !== "blocked") {
            throw new Error("Managed structured result has no terminal status.");
          }
          resultStatus = parsedResult.status;
          resultChangedPaths = [...new Set(parsedResult.changed_files)].sort();
        } catch {
          validFreshResult = false;
        }
      }

      let observedGit: Awaited<ReturnType<GitService["status"]>> | undefined;
      let fingerprint: string | undefined;
      try {
        const git = new GitService(root);
        [observedGit, fingerprint] = await Promise.all([git.status(), git.worktreeFingerprint()]);
      } catch {
        // Terminal state remains observable even when Git observation fails.
      }

      const completedDate = this.now();
      const completedAt = completedDate.toISOString();
      const elapsed = activeAttemptElapsedMs(attempt!, completedDate.getTime());
      const awaitingInputMs = awaitingInputMsAt(attempt!, completedDate.getTime());
      const activeRuntimeMs = Math.min(
        DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        run.runner.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        session!.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        (attempt!.active_runtime_ms_before ?? session!.active_runtime_ms) + elapsed
      );
      const terminal = terminalDisposition(turnStatus, validFreshResult, resultStatus);
      const warnings = [...new Set([
        ...status!.warnings,
        ...(turnStatus === "completed" && !validFreshResult ? ["AGENT_RUN_RESULT_NOT_REFRESHED"] : []),
        ...(turnStatus === "failed" ? ["AGENT_RUN_TURN_FAILED"] : []),
        ...(turnStatus === "interrupted" ? ["AGENT_RUN_TURN_INTERRUPTED"] : [])
      ])];

      await interactions.writeSession({
        repo_id: session!.repo_id,
        run_id: session!.run_id,
        provider: session!.provider,
        thread_id: session!.thread_id,
        ...(session!.model === undefined ? {} : { model: session!.model }),
        turn_index: session!.turn_index,
        ...(session!.max_runtime_ms === undefined ? {} : { max_runtime_ms: session!.max_runtime_ms }),
        active_runtime_ms: activeRuntimeMs,
        last_consumed_reply_turn_index: session!.last_consumed_reply_turn_index,
        created_at: session!.created_at
      });
      await runs.writeStatus({
        ...status!,
        status: terminal,
        revision: status!.revision + 1,
        completed_at: completedAt,
        updated_at: completedAt,
        result_found: validFreshResult,
        head_after: observedGit?.head_sha ?? status!.head_after,
        worktree_fingerprint_after: fingerprint ?? status!.worktree_fingerprint_after,
        changed_paths: validFreshResult ? resultChangedPaths : [],
        warnings
      });
      await attempts.write({
        repo_id: attempt!.repo_id,
        run_id: attempt!.run_id,
        provider: attempt!.provider,
        operation: attempt!.operation,
        turn_index: attempt!.turn_index,
        state: "settled",
        app_server_turn_id: binding.app_server_turn_id,
        ...(attempt!.result_sha256_before === undefined ? {} : { result_sha256_before: attempt!.result_sha256_before }),
        ...(attempt!.active_runtime_ms_before === undefined ? {} : { active_runtime_ms_before: attempt!.active_runtime_ms_before }),
        ...(awaitingInputMs === 0 ? {} : { awaiting_input_ms: awaitingInputMs }),
        started_at: attempt!.started_at
      });
      await runs.appendEvent({
        repo_id: binding.repo_id,
        run_id: binding.run_id,
        event_type: terminal === "completed" ? "completed" : terminal === "canceled" ? "canceled" : "failed",
        summary: terminal === "completed"
          ? "The managed Codex continuation turn completed."
          : "The managed Codex continuation turn ended without a fresh completed result."
      });
    });
  }

  private boundRepo(binding: ManagedCodexAppServerTurnBinding): { root: string; task: TaskRepoBinding } {
    const repo = this.registry.get(binding.repo_id);
    if (!repo.task || repo.task.authority === "inspect") throw new Error("Managed turn task binding is unavailable.");
    return { root: repo.root, task: repo.task };
  }

  private withRunLock<T>(task: TaskRepoBinding, runId: string, action: () => Promise<T>): Promise<T> {
    return this.tasks.locks.withLock(`task:${task.task_id}`, async () =>
      this.tasks.locks.withLock(`agent-run:${task.task_id}:${runId}`, action)
    );
  }

  private abortTurnQuestions(turnId: string): void {
    for (const pending of this.pendingQuestions.values()) {
      if (pending.turn_id === turnId) pending.controller.abort();
    }
  }
}

function assertActiveBinding(
  binding: ManagedCodexAppServerTurnBinding,
  status: AgentRunnerStatus | undefined,
  attempt: Awaited<ReturnType<DelegationAttemptStore["read"]>>,
  session: Awaited<ReturnType<DelegationInteractionStore["readSession"]>>
): void {
  if (
    !status
    || status.repo_id !== binding.repo_id
    || status.run_id !== binding.run_id
    || status.runner !== "codex_app_server"
    || !attempt
    || attempt.state !== "in_flight"
    || attempt.provider !== "codex_app_server"
    || attempt.turn_index !== binding.turn_index
    || attempt.app_server_turn_id !== binding.app_server_turn_id
    || !session
    || session.provider !== "codex_app_server"
    || session.thread_id !== binding.thread_id
    || session.turn_index !== binding.turn_index
  ) {
    throw new Error("Managed App Server turn binding changed.");
  }
}

function mapQuestions(questions: z.infer<typeof RequestUserInputParamsSchema>["questions"]): QuestionMapping[] | undefined {
  const mappings = questions.map((question) => {
    const questionId = `q-${canonicalSha256(question.id).slice(0, 24)}`;
    const optionLabels = (question.options ?? []).map(({ label }) => label);
    const prompt = `${question.header}: ${question.question}`.slice(0, 2_000);
    return {
      original_id: question.id,
      public_question: {
        question_id: questionId,
        prompt,
        ...(optionLabels.length === 0 ? {} : { options: optionLabels })
      },
    };
  });
  return new Set(mappings.map(({ public_question }) => public_question.question_id)).size === mappings.length
    ? mappings
    : undefined;
}

function buildAppServerAnswers(
  mappings: QuestionMapping[],
  supplied: Array<{ question_id: string; answer: string }>
): Record<string, { answers: string[] }> {
  const byPublicId = new Map(supplied.map((answer) => [answer.question_id, answer.answer]));
  const result: Record<string, { answers: string[] }> = {};
  for (const mapping of mappings) {
    const answer = byPublicId.get(mapping.public_question.question_id);
    if (!answer) throw new Error("Managed reply does not answer every question.");
    result[mapping.original_id] = { answers: [answer] };
  }
  return result;
}

function terminalDisposition(
  turnStatus: "completed" | "interrupted" | "failed",
  validFreshResult: boolean,
  resultStatus: "completed" | "blocked" | undefined
): AgentRunnerStatus["status"] {
  if (turnStatus === "interrupted") return "canceled";
  if (turnStatus === "failed") return "failed";
  return validFreshResult && resultStatus === "completed" ? "completed" : "failed";
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

type AttemptPauseFields = Pick<AgentRunnerAttempt, "awaiting_input_ms" | "awaiting_input_started_at">;

function attemptWriteInput(
  attempt: AgentRunnerAttempt,
  pause: Partial<AttemptPauseFields>
): Parameters<DelegationAttemptStore["write"]>[0] {
  const awaitingInputMs = pause.awaiting_input_ms ?? attempt.awaiting_input_ms;
  const awaitingInputStartedAt = Object.prototype.hasOwnProperty.call(pause, "awaiting_input_started_at")
    ? pause.awaiting_input_started_at
    : attempt.awaiting_input_started_at;
  return {
    repo_id: attempt.repo_id,
    run_id: attempt.run_id,
    provider: attempt.provider,
    operation: attempt.operation,
    turn_index: attempt.turn_index,
    state: attempt.state,
    ...(attempt.app_server_turn_id === undefined ? {} : { app_server_turn_id: attempt.app_server_turn_id }),
    ...(attempt.result_sha256_before === undefined ? {} : { result_sha256_before: attempt.result_sha256_before }),
    ...(attempt.active_runtime_ms_before === undefined ? {} : { active_runtime_ms_before: attempt.active_runtime_ms_before }),
    ...(awaitingInputMs === undefined ? {} : { awaiting_input_ms: awaitingInputMs }),
    ...(awaitingInputStartedAt === undefined ? {} : { awaiting_input_started_at: awaitingInputStartedAt }),
    started_at: attempt.started_at
  };
}

function resumedAttemptInput(
  attempt: AgentRunnerAttempt,
  now: Date
): Parameters<DelegationAttemptStore["write"]>[0] {
  return attemptWriteInput(attempt, {
    awaiting_input_ms: awaitingInputMsAt(attempt, now.getTime()),
    awaiting_input_started_at: undefined
  });
}

function awaitingInputMsAt(attempt: AgentRunnerAttempt, endedAt: number): number {
  const openPause = attempt.awaiting_input_started_at === undefined
    ? 0
    : elapsedMs(attempt.awaiting_input_started_at, endedAt);
  return (attempt.awaiting_input_ms ?? 0) + openPause;
}

function activeAttemptElapsedMs(attempt: AgentRunnerAttempt, endedAt: number): number {
  const elapsed = elapsedMs(attempt.started_at, endedAt);
  return elapsed - Math.min(elapsed, awaitingInputMsAt(attempt, endedAt));
}

function elapsedMs(startedAt: string, endedAt: number): number {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) && Number.isFinite(endedAt) ? Math.max(0, endedAt - start) : 0;
}
