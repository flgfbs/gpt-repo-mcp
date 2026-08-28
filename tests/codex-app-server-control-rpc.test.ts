import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  assertSafeControlSocket,
  CodexAppServerControlRpc,
  type CodexAppServerEventSink,
  type CodexAppServerMessageChannel,
  type CodexAppServerNotification,
  type CodexAppServerServerRequest,
  type CodexAppServerServerRequestDisposition
} from "../src/delegation/codex-app-server-control-rpc.js";
import {
  CodexAppServerThreadStartError,
  CodexAppServerTurnStartError
} from "../src/delegation/codex-app-server-adapter.js";
import type { ManagedCodexAppServerTurnBinding } from "../src/delegation/codex-app-server-adapter.js";

describe("Codex App Server control RPC", () => {
  test("initializes once and holds owner notifications until an accepted turn is bound", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel((message, current) => {
      if (message.method === "turn/start") {
        current.respond(message.id, { turn: { id: "private-turn", status: "inProgress" } });
        current.notify("turn/completed", { turn: { id: "private-turn", status: "completed" } });
      }
    });
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });

    const response = await rpc.withNotificationDeliveryBarrier(async () => {
      const started = await rpc.request("turn/start", {
        threadId: "private-thread",
        input: [{ type: "text", text: "Continue." }]
      });
      expect(sink.notifications).toEqual([]);
      rpc.bindAcceptedTurn({
        repo_id: "task-repo",
        run_id: "2026-08-26T120000Z-control-rpc",
        thread_id: "private-thread",
        app_server_turn_id: "private-turn",
        turn_index: 2
      });
      return started;
    });

    expect(response).toEqual({ turn: { id: "private-turn", status: "inProgress" } });
    expect(channel.sent.map(({ method }) => method)).toEqual(["initialize", "initialized", "turn/start"]);
    expect(channel.sent[0]?.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    expect(sink.bindings).toHaveLength(1);
    await vi.waitFor(() => expect(sink.notifications).toEqual([{
      method: "turn/completed",
      params: { turn: { id: "private-turn", status: "completed" } }
    }]));
    await rpc.close();
  });

  test("returns a protocol error when the owner sink has no safe method-specific response", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel();
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    await rpc.request("thread/read", { threadId: "private-thread", includeTurns: false });

    channel.serverRequest(41, "item/commandExecution/requestApproval", {
      threadId: "private-thread",
      turnId: "private-turn"
    });
    await vi.waitFor(() => expect(sink.serverRequests).toHaveLength(1));
    await vi.waitFor(() => expect(channel.sent).toContainEqual({
      id: 41,
      error: { code: -32601, message: "Server request method is not supported." }
    }));
    await rpc.close();
  });

  test("writes the sink's exact negative approval result to the originating request", async () => {
    const channel = new FakeMessageChannel();
    const rpc = new CodexAppServerControlRpc(new NegativeApprovalSink(), {
      channel_factory: () => channel
    });
    await rpc.request("thread/read", { threadId: "private-thread", includeTurns: false });

    channel.serverRequest(43, "item/commandExecution/requestApproval", {
      threadId: "private-thread",
      turnId: "private-turn",
      itemId: "private-item",
      startedAtMs: 1
    });
    await vi.waitFor(() => expect(channel.sent).toContainEqual({
      id: 43,
      result: { decision: "cancel" }
    }));
    await rpc.close();
  });

  test("holds synthetic reconciled completion until its exact turn binding is installed", async () => {
    const sink = new RecordingSink();
    const rpc = new CodexAppServerControlRpc(sink, {
      channel_factory: () => new FakeMessageChannel()
    });
    const binding = {
      repo_id: "task-repo",
      run_id: "2026-08-26T120000Z-reconciled-control-rpc",
      thread_id: "private-thread",
      app_server_turn_id: "private-turn",
      turn_index: 2
    };

    await rpc.withNotificationDeliveryBarrier(async () => {
      rpc.reconcileAcceptedTurn(binding, "interrupted");
      expect(sink.bindings).toEqual([binding]);
      expect(sink.notifications).toEqual([]);
    });
    await vi.waitFor(() => expect(sink.notifications).toEqual([{
      method: "turn/completed",
      params: { turn: { id: "private-turn", status: "interrupted" } }
    }]));
    await rpc.close();
  });

  test("returns a bounded internal error when the owner sink cannot resolve a server request", async () => {
    const channel = new FakeMessageChannel();
    const rpc = new CodexAppServerControlRpc(new ThrowingRequestSink(), {
      channel_factory: () => channel
    });
    await rpc.request("thread/read", { threadId: "private-thread", includeTurns: false });

    channel.serverRequest(42, "item/tool/call", { secret: "must-not-echo" });
    await vi.waitFor(() => expect(channel.sent).toContainEqual({
      id: 42,
      error: { code: -32603, message: "Server request could not be resolved safely." }
    }));
    expect(JSON.stringify(channel.sent.find((message) => message.id === 42))).not.toContain("must-not-echo");
    await rpc.close();
  });

  test("serializes overlapping notification barriers instead of rejecting a different run", async () => {
    const rpc = new CodexAppServerControlRpc(new RecordingSink(), {
      channel_factory: () => new FakeMessageChannel()
    });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const order: string[] = [];
    const first = rpc.withNotificationDeliveryBarrier(async () => {
      order.push("first-enter");
      await firstHeld;
      order.push("first-exit");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-enter"]));
    const second = rpc.withNotificationDeliveryBarrier(async () => {
      order.push("second-enter");
      order.push("second-exit");
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
    await rpc.close();
  });

  test("rejects a reentrant notification barrier instead of awaiting its own release", async () => {
    const rpc = new CodexAppServerControlRpc(new RecordingSink(), {
      channel_factory: () => new FakeMessageChannel()
    });

    await rpc.withNotificationDeliveryBarrier(async () => {
      await expect(rpc.withNotificationDeliveryBarrier(async () => undefined))
        .rejects.toThrow("Nested Codex App Server notification barriers are not allowed.");
    });
    await rpc.close();
  });

  test("retries the same terminal sink notification once after a transient local failure", async () => {
    const sink = new FlakyTerminalSink();
    const channel = new FakeMessageChannel((message, current) => {
      if (message.method === "turn/start") {
        current.respond(message.id, { turn: { id: "private-turn", status: "inProgress" } });
        current.notify("turn/completed", { turn: { id: "private-turn", status: "completed" } });
      }
    });
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    await rpc.withNotificationDeliveryBarrier(async () => {
      await rpc.request("turn/start", { threadId: "private-thread", input: [] });
    });
    await vi.waitFor(() => expect(sink.notifications).toHaveLength(1));
    expect(sink.deliveryAttempts).toBe(2);
    expect(channel.sent.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await rpc.close();
  });

  test("rejects a control socket below a group-writable ancestor", async () => {
    const fixture = await mkdtemp("/tmp/cas-");
    const unsafeAncestor = join(fixture, "unsafe");
    const controlDir = join(unsafeAncestor, "control");
    const socketPath = join(controlDir, "server.sock");
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    await chmod(unsafeAncestor, 0o770);
    const server = createServer();
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(socketPath, resolvePromise);
      });
      await chmod(socketPath, 0o600);
      await expect(assertSafeControlSocket(socketPath)).rejects.toMatchObject({
        code: "RUNNER_PROVIDER_UNAVAILABLE"
      });
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await rm(fixture, { recursive: true, force: true });
    }
  });

  test("classifies a JSON-RPC turn-start rejection as confirmed not-started", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel((message, current) => {
      if (message.method === "turn/start") current.fail(message.id);
    });
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    await expect(rpc.request("turn/start", { threadId: "private-thread", input: [] }))
      .rejects.toBeInstanceOf(CodexAppServerTurnStartError);
    await rpc.close();
  });

  test("classifies a JSON-RPC thread-start rejection as confirmed not-started", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel((message, current) => {
      if (message.method === "thread/start") current.fail(message.id);
    });
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    await expect(rpc.request("thread/start", { cwd: "/private/tmp/fixture" }))
      .rejects.toBeInstanceOf(CodexAppServerThreadStartError);
    await rpc.close();
  });

  test("reconnects once before thread start when the first initialization does not complete", async () => {
    const sink = new RecordingSink();
    const first = new FakeMessageChannel(undefined, false);
    const second = new FakeMessageChannel((message, current) => {
      if (message.method === "thread/start") {
        current.respond(message.id, { thread: { id: "private-thread" } });
      }
    });
    const channels = [first, second];
    const rpc = new CodexAppServerControlRpc(sink, {
      channel_factory: () => channels.shift() ?? second,
      initialize_timeout_ms: 100
    });

    await expect(rpc.request("thread/start", { cwd: "/private/tmp/fixture" }))
      .resolves.toEqual({ thread: { id: "private-thread" } });
    expect(first.sent.filter(({ method }) => method === "thread/start")).toHaveLength(0);
    expect(first.sent.map(({ method }) => method)).toEqual(["initialize"]);
    expect(second.sent.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(second.sent.map(({ method }) => method)).toEqual(["initialize", "initialized", "thread/start"]);
    await rpc.close();
  });

  test("reports request-not-sent after two pre-send connection failures", async () => {
    const sink = new RecordingSink();
    const channels = [
      new FakeMessageChannel(undefined, true, true),
      new FakeMessageChannel(undefined, true, true)
    ];
    const rpc = new CodexAppServerControlRpc(sink, {
      channel_factory: () => channels.shift() ?? new FakeMessageChannel(undefined, true, true)
    });

    await expect(rpc.request("thread/start", { cwd: "/private/tmp/fixture" }))
      .rejects.toMatchObject({
        name: "CodexAppServerThreadStartError",
        effect_state: "request_not_sent"
      });
    expect(channels).toHaveLength(0);
    await rpc.close();
  });

  test("bounds initialization when the owner control connection never acknowledges", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel(undefined, false);
    const rpc = new CodexAppServerControlRpc(sink, {
      channel_factory: () => channel,
      initialize_timeout_ms: 100
    });
    await expect(rpc.request("thread/read", { threadId: "private-thread", includeTurns: false }))
      .rejects.toMatchObject({ code: "RUNNER_PROVIDER_UNAVAILABLE" });
    expect(channel.sent.filter(({ method }) => method === "initialize")).toHaveLength(1);
    await rpc.close();
  });

  test("rejects an acknowledged pending request after disconnect without replaying it", async () => {
    const sink = new RecordingSink();
    const channel = new FakeMessageChannel((message, current) => {
      if (message.method === "turn/start") current.disconnect();
    });
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    await expect(rpc.request("turn/start", { threadId: "private-thread", input: [] })).rejects.toThrow();
    expect(channel.sent.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await rpc.close();
  });
});

class RecordingSink implements CodexAppServerEventSink {
  readonly bindings: ManagedCodexAppServerTurnBinding[] = [];
  readonly notifications: CodexAppServerNotification[] = [];
  readonly serverRequests: CodexAppServerServerRequest[] = [];

  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void {
    this.bindings.push(binding);
  }

  async handleNotification(notification: CodexAppServerNotification): Promise<void> {
    this.notifications.push(notification);
  }

  async handleServerRequest(request: CodexAppServerServerRequest): Promise<CodexAppServerServerRequestDisposition> {
    this.serverRequests.push(request);
    return { handled: false };
  }

  async close(): Promise<void> {}
}

class FlakyTerminalSink extends RecordingSink {
  deliveryAttempts = 0;

  override async handleNotification(notification: CodexAppServerNotification): Promise<void> {
    this.deliveryAttempts += 1;
    if (this.deliveryAttempts === 1) throw new Error("transient local sink failure");
    await super.handleNotification(notification);
  }
}

class ThrowingRequestSink extends RecordingSink {
  override async handleServerRequest(): Promise<CodexAppServerServerRequestDisposition> {
    throw new Error("private sink failure");
  }
}

class NegativeApprovalSink extends RecordingSink {
  override async handleServerRequest(
    request: CodexAppServerServerRequest
  ): Promise<CodexAppServerServerRequestDisposition> {
    this.serverRequests.push(request);
    return { handled: true, result: { decision: "cancel" } };
  }
}

type JsonMessage = Record<string, unknown> & { method?: string; id?: string | number };

class FakeMessageChannel implements CodexAppServerMessageChannel {
  readonly sent: JsonMessage[] = [];
  private handlers?: { message(value: string): void; close(): void; error(): void };

  constructor(
    private readonly onSend?: (message: JsonMessage, channel: FakeMessageChannel) => void,
    private readonly respondToInitialize = true,
    private readonly failOpen = false
  ) {}

  async open(handlers: { message(value: string): void; close(): void; error(): void }): Promise<void> {
    if (this.failOpen) throw new Error("fixture connection failure");
    this.handlers = handlers;
  }

  async send(value: string): Promise<void> {
    const message = JSON.parse(value) as JsonMessage;
    this.sent.push(message);
    if (message.method === "initialize") {
      if (this.respondToInitialize) this.respond(message.id, { userAgent: "fixture" });
      return;
    }
    if (message.method === "thread/read") {
      this.respond(message.id, { thread: { id: "private-thread" } });
      return;
    }
    this.onSend?.(message, this);
  }

  async close(): Promise<void> {}

  respond(id: JsonMessage["id"], result: unknown): void {
    if (id === undefined) return;
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ id, result })));
  }

  fail(id: JsonMessage["id"]): void {
    if (id === undefined) return;
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ id, error: { code: -32000, message: "Rejected" } })));
  }

  notify(method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ method, params })));
  }

  serverRequest(id: string | number, method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ id, method, params })));
  }

  disconnect(): void {
    queueMicrotask(() => this.handlers?.close());
  }
}
