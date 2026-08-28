import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { RepoReaderError } from "../runtime/errors.js";

export type CodexAppServerMethod = "thread/read" | "thread/resume" | "thread/start" | "turn/start";

export type CodexAppServerTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type ManagedCodexAppServerTurnBinding = {
  repo_id: string;
  run_id: string;
  thread_id: string;
  app_server_turn_id: string;
  turn_index: number;
};

export interface CodexAppServerRpc {
  request(method: CodexAppServerMethod, params: Record<string, unknown>): Promise<unknown>;
  /**
   * Delay delivery of App Server notifications to the owner result/status sink
   * until action settles. Requests made by action must remain callable.
   */
  withNotificationDeliveryBarrier<T>(action: () => Promise<T>): Promise<T>;
  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void;
  reconcileAcceptedTurn(binding: ManagedCodexAppServerTurnBinding, status: CodexAppServerTurnStatus): void;
}

export class CodexAppServerTurnStartError extends Error {
  constructor(readonly effect_state: "not_started" | "unknown") {
    super(effect_state === "not_started"
      ? "Codex App Server confirmed that the turn was not started."
      : "Codex App Server turn-start effect is unknown.");
    this.name = "CodexAppServerTurnStartError";
  }
}

export class CodexAppServerThreadStartError extends Error {
  constructor(readonly effect_state: "not_started" | "unknown") {
    super(effect_state === "not_started"
      ? "Codex App Server confirmed that the thread was not started."
      : "Codex App Server thread-start effect is unknown.");
    this.name = "CodexAppServerThreadStartError";
  }
}

export type PreparedCodexThread = {
  thread_id: string;
  model: string;
  model_provider: string;
};

export type CodexAppServerAdapterOptions = {
  request_timeout_ms?: number;
};

const ThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }).passthrough(),
  z.object({ type: z.literal("idle") }).passthrough(),
  z.object({ type: z.literal("systemError") }).passthrough(),
  z.object({ type: z.literal("active") }).passthrough()
]);

const ThreadSchema = z.object({
  id: z.string().min(1).max(1_024).refine((value) => !/[\0\r\n]/.test(value)),
  modelProvider: z.string().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value)),
  cwd: z.string().min(1).max(4_096).refine((value) => !value.includes("\0")),
  status: ThreadStatusSchema
}).passthrough();

const ThreadReadResponseSchema = z.object({ thread: ThreadSchema }).passthrough();
const ReconciliationTurnSchema = z.object({
  id: z.string().min(1).max(1_024).refine((value) => !/[\0\r\n]/.test(value)),
  status: z.enum(["inProgress", "completed", "interrupted", "failed"])
}).passthrough();
const ReconciliationThreadReadResponseSchema = z.object({
  thread: ThreadSchema.extend({ turns: z.array(ReconciliationTurnSchema) })
}).passthrough();
const ThreadResumeResponseSchema = z.object({
  thread: ThreadSchema,
  model: z.string().min(1).max(512),
  modelProvider: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4_096)
}).passthrough();
const ThreadStartResponseSchema = z.object({
  thread: ThreadSchema,
  model: z.string().min(1).max(512).refine((value) => !/[\0\r\n]/.test(value)),
  modelProvider: z.string().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value)),
  cwd: z.string().min(1).max(4_096).refine((value) => !value.includes("\0")),
  approvalPolicy: z.literal("never"),
  sandbox: z.object({
    type: z.literal("workspaceWrite"),
    networkAccess: z.boolean().optional()
  }).passthrough()
}).passthrough();
const TurnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1).max(1_024).refine((value) => !/[\0\r\n]/.test(value)),
    status: z.literal("inProgress")
  }).passthrough()
}).passthrough();

/**
 * Narrow protocol adapter for an owner-controlled Codex App Server connection.
 * It never selects an executable, endpoint, model, provider, or machine. A new
 * owner-local thread is constrained to the exact repository root, workspace
 * write sandbox, and never-approve policy. Continuation turn start deliberately
 * sends no overrides and preserves the previously bound thread policy.
 */
export class CodexAppServerAdapter {
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly rpc: CodexAppServerRpc,
    options: CodexAppServerAdapterOptions = {}
  ) {
    this.requestTimeoutMs = boundedTimeout(options.request_timeout_ms ?? 30_000);
  }

  async startThread(input: { repo_root: string }): Promise<PreparedCodexThread> {
    let response: unknown;
    try {
      response = await this.request("thread/start", {
        cwd: await realpath(resolve(input.repo_root)),
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: "chat_pro_repository_mcp_owner_runner"
      });
    } catch (error) {
      if (error instanceof CodexAppServerThreadStartError) throw error;
      throw new CodexAppServerThreadStartError("unknown");
    }
    let started: z.infer<typeof ThreadStartResponseSchema>;
    try {
      started = ThreadStartResponseSchema.parse(response);
    } catch {
      throw new CodexAppServerThreadStartError("unknown");
    }
    await Promise.all([
      assertRepositoryRoot(started.thread.cwd, input.repo_root),
      assertRepositoryRoot(started.cwd, input.repo_root)
    ]);
    if (started.thread.status.type !== "idle") {
      throw new CodexAppServerThreadStartError("unknown");
    }
    if (started.thread.modelProvider !== started.modelProvider) {
      throw new RepoReaderError(
        "RUNNER_POLICY_BLOCKED",
        "Codex App Server returned inconsistent model-provider bindings for the new thread."
      );
    }
    if (started.sandbox.networkAccess === true) {
      throw new RepoReaderError(
        "RUNNER_POLICY_BLOCKED",
        "Codex App Server enabled network access for a new managed thread; initial launch requires the local workspace boundary."
      );
    }
    return {
      thread_id: started.thread.id,
      model: started.model,
      model_provider: started.modelProvider
    };
  }

  async prepare(input: { thread_id: string; model: string; repo_root: string }): Promise<PreparedCodexThread> {
    let read;
    try {
      read = ThreadReadResponseSchema.parse(await this.request("thread/read", {
        threadId: input.thread_id,
        includeTurns: false
      }));
    } catch (error) {
      if (error instanceof RepoReaderError) throw error;
      throw providerFailure("Codex App Server could not read the bound thread before turn start.");
    }
    assertThreadIdentity(read.thread, input.thread_id);
    await assertRepositoryRoot(read.thread.cwd, input.repo_root);
    assertIdleForContinuation(read.thread.status.type);

    let resumed;
    try {
      resumed = ThreadResumeResponseSchema.parse(await this.request("thread/resume", {
        threadId: input.thread_id,
        excludeTurns: true
      }));
    } catch {
      throw providerFailure("Codex App Server could not resume the bound thread before turn start.");
    }
    assertThreadIdentity(resumed.thread, input.thread_id);
    await Promise.all([
      assertRepositoryRoot(resumed.thread.cwd, input.repo_root),
      assertRepositoryRoot(resumed.cwd, input.repo_root)
    ]);
    if (resumed.thread.status.type !== "idle") {
      throw providerFailure("Codex App Server did not return the resumed thread in an idle state.");
    }
    if (
      resumed.thread.modelProvider !== read.thread.modelProvider
      || resumed.modelProvider !== read.thread.modelProvider
    ) {
      throw new RepoReaderError(
        "RUNNER_POLICY_BLOCKED",
        "Codex App Server changed the bound model provider during thread resume; no fallback is allowed."
      );
    }
    if (resumed.model !== input.model) {
      throw new RepoReaderError(
        "RUNNER_POLICY_BLOCKED",
        "Codex App Server returned a different bound model during thread resume; no fallback is allowed."
      );
    }
    return { thread_id: input.thread_id, model: input.model, model_provider: resumed.modelProvider };
  }

  async startTurn(input: { prepared: PreparedCodexThread; instruction: string }): Promise<{ app_server_turn_id: string }> {
    let response: unknown;
    try {
      response = await this.request("turn/start", {
        threadId: input.prepared.thread_id,
        input: [{ type: "text", text: input.instruction, text_elements: [] }]
      });
    } catch (error) {
      if (error instanceof CodexAppServerTurnStartError) throw error;
      throw new CodexAppServerTurnStartError("unknown");
    }
    try {
      const started = TurnStartResponseSchema.parse(response);
      return { app_server_turn_id: started.turn.id };
    } catch {
      throw new CodexAppServerTurnStartError("unknown");
    }
  }

  withNotificationDeliveryBarrier<T>(action: () => Promise<T>): Promise<T> {
    return this.rpc.withNotificationDeliveryBarrier(action);
  }

  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void {
    this.rpc.bindAcceptedTurn(binding);
  }

  async reconcileTurn(input: {
    binding: ManagedCodexAppServerTurnBinding;
    repo_root: string;
  }): Promise<CodexAppServerTurnStatus> {
    return this.withNotificationDeliveryBarrier(async () => {
      let read;
      try {
        read = ReconciliationThreadReadResponseSchema.parse(await this.request("thread/read", {
          threadId: input.binding.thread_id,
          includeTurns: true
        }));
      } catch (error) {
        if (error instanceof RepoReaderError) throw error;
        throw providerFailure("Codex App Server could not read the exact in-flight turn for reconciliation.");
      }
      assertThreadIdentity(read.thread, input.binding.thread_id);
      await assertRepositoryRoot(read.thread.cwd, input.repo_root);
      const matches = read.thread.turns.filter(({ id }) => id === input.binding.app_server_turn_id);
      const latest = read.thread.turns.at(-1);
      if (matches.length !== 1 || latest?.id !== input.binding.app_server_turn_id) {
        throw new RepoReaderError(
          "RUNNER_INTERACTION_INVALID",
          "Codex App Server did not return the persisted in-flight turn as the unique latest turn."
        );
      }
      const status = matches[0]!.status;
      if (
        (status === "inProgress" && read.thread.status.type !== "active")
        || (status !== "inProgress" && read.thread.status.type === "active")
      ) {
        throw new RepoReaderError(
          "RUNNER_INTERACTION_INVALID",
          "Codex App Server thread and turn status disagree during reconciliation."
        );
      }
      this.rpc.reconcileAcceptedTurn(input.binding, status);
      return status;
    });
  }

  private async request(method: CodexAppServerMethod, params: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.rpc.request(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Codex App Server request timed out.")), this.requestTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function assertThreadIdentity(thread: z.infer<typeof ThreadSchema>, expectedThreadId: string): void {
  if (thread.id !== expectedThreadId) {
    throw new RepoReaderError(
      "RUNNER_POLICY_BLOCKED",
      "Codex App Server returned a different thread; implicit thread fallback is forbidden."
    );
  }
}

function assertIdleForContinuation(status: z.infer<typeof ThreadStatusSchema>["type"]): void {
  if (status === "active") {
    throw new RepoReaderError("RUNNER_LOCK_ACTIVE", "The bound Codex thread already has an active turn.");
  }
  if (status === "systemError") {
    throw providerFailure("The bound Codex thread is in a system-error state.");
  }
}

async function assertRepositoryRoot(threadRoot: string, expectedRoot: string): Promise<void> {
  try {
    const [actual, expected] = await Promise.all([realpath(resolve(threadRoot)), realpath(resolve(expectedRoot))]);
    if (actual === expected) return;
  } catch {
    // The stable policy error below intentionally omits physical paths.
  }
  throw new RepoReaderError(
    "RUNNER_POLICY_BLOCKED",
    "Codex App Server thread repository identity does not match the selected task repository."
  );
}

function providerFailure(message: string): RepoReaderError {
  return new RepoReaderError("RUNNER_PROVIDER_FAILED", message);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error("Codex App Server request timeout must be between 100 and 60000 milliseconds.");
  }
  return value;
}
