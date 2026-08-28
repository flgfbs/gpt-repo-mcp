import { AsyncLocalStorage } from "node:async_hooks";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import WebSocket from "ws";
import {
  CodexAppServerTurnStartError,
  type CodexAppServerMethod,
  type CodexAppServerRpc,
  type ManagedCodexAppServerTurnBinding
} from "./codex-app-server-adapter.js";
import { RepoReaderError } from "../runtime/errors.js";

const MAX_APP_SERVER_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 5_000;
const TERMINAL_SINK_RETRY_MS = 25;

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

export type CodexAppServerServerRequest = {
  id: JsonRpcId;
  method: string;
  params: JsonRecord;
};

export type CodexAppServerNotification = {
  method: string;
  params: JsonRecord;
};

export type CodexAppServerServerRequestDisposition =
  | { handled: false }
  | { handled: true; result: unknown }
  | { handled: true; error: { code: number; message: string } };

export interface CodexAppServerEventSink {
  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void;
  handleNotification(notification: CodexAppServerNotification): Promise<void>;
  handleServerRequest(request: CodexAppServerServerRequest): Promise<CodexAppServerServerRequestDisposition>;
  close(): Promise<void>;
}

export interface CodexAppServerMessageChannel {
  open(handlers: {
    message(value: string): void;
    close(): void;
    error(): void;
  }): Promise<void>;
  send(value: string): Promise<void>;
  close(): Promise<void>;
}

export type CodexAppServerControlRpcOptions = {
  channel_factory?: () => CodexAppServerMessageChannel;
  socket_path?: string;
  codex_home?: string;
  env?: NodeJS.ProcessEnv;
  initialize_timeout_ms?: number;
};

class CodexAppServerRpcResponseError extends Error {}

export class CodexAppServerControlRpc implements CodexAppServerRpc {
  private readonly channelFactory: () => CodexAppServerMessageChannel;
  private channel?: CodexAppServerMessageChannel;
  private connecting?: Promise<void>;
  private initialized = false;
  private closed = false;
  private nextRequestId = 1;
  private barrierActive = false;
  private barrierTail: Promise<void> = Promise.resolve();
  private barrierOwner?: symbol;
  private readonly barrierContext = new AsyncLocalStorage<symbol>();
  private readonly initializeTimeoutMs: number;
  private bufferedMessages: Array<CodexAppServerNotification | CodexAppServerServerRequest> = [];
  private readonly pending = new Map<string, {
    method: string;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }>();

  constructor(
    private readonly sink: CodexAppServerEventSink,
    options: CodexAppServerControlRpcOptions = {}
  ) {
    const socketPath = options.socket_path ?? defaultControlSocketPath(options.codex_home, options.env);
    this.channelFactory = options.channel_factory ?? (() => new UnixWebSocketMessageChannel(socketPath));
    this.initializeTimeoutMs = boundedInitializeTimeout(
      options.initialize_timeout_ms ?? DEFAULT_INITIALIZE_TIMEOUT_MS
    );
  }

  async request(method: CodexAppServerMethod, params: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    try {
      return await this.sendRequest(method, params);
    } catch (error) {
      if (method === "turn/start" && error instanceof CodexAppServerRpcResponseError) {
        throw new CodexAppServerTurnStartError("not_started");
      }
      throw error;
    }
  }

  bindAcceptedTurn(binding: ManagedCodexAppServerTurnBinding): void {
    this.sink.bindAcceptedTurn(binding);
  }

  reconcileAcceptedTurn(
    binding: ManagedCodexAppServerTurnBinding,
    status: "inProgress" | "completed" | "interrupted" | "failed"
  ): void {
    this.sink.bindAcceptedTurn(binding);
    if (status === "inProgress") return;
    const completed = {
      method: "turn/completed",
      params: { turn: { id: binding.app_server_turn_id, status } }
    } satisfies CodexAppServerNotification;
    if (this.barrierActive) {
      this.bufferedMessages.push(completed);
      return;
    }
    void this.dispatchOwnerMessage(completed);
  }

  async withNotificationDeliveryBarrier<T>(action: () => Promise<T>): Promise<T> {
    const inheritedOwner = this.barrierContext.getStore();
    if (inheritedOwner !== undefined && inheritedOwner === this.barrierOwner) {
      throw new Error("Nested Codex App Server notification barriers are not allowed.");
    }
    let releaseBarrier!: () => void;
    const previousBarrier = this.barrierTail;
    this.barrierTail = new Promise<void>((resolvePromise) => {
      releaseBarrier = resolvePromise;
    });
    await previousBarrier;
    const owner = Symbol("codex-app-server-notification-barrier");
    this.barrierOwner = owner;
    this.barrierActive = true;
    try {
      return await this.barrierContext.run(owner, action);
    } finally {
      if (this.barrierOwner === owner) this.barrierOwner = undefined;
      this.barrierActive = false;
      const buffered = this.bufferedMessages.splice(0);
      for (const message of buffered) {
        // The continuation operation still owns the task/run locks while this
        // barrier unwinds. Owner delivery must begin only after durable binding,
        // but must not wait on those same locks before the operation can return.
        void this.dispatchOwnerMessage(message);
      }
      releaseBarrier();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending();
    const channel = this.channel;
    this.channel = undefined;
    this.initialized = false;
    await this.sink.close();
    await channel?.close().catch(() => undefined);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw providerUnavailable();
    if (this.initialized && this.channel) return;
    if (!this.connecting) {
      this.connecting = this.connectAndInitialize().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async connectAndInitialize(): Promise<void> {
    const channel = this.channelFactory();
    try {
      await channel.open({
        message: (value) => this.receive(value),
        close: () => this.connectionLost(),
        error: () => this.connectionLost()
      });
      this.channel = channel;
      await withTimeout(this.sendRequest("initialize", {
        clientInfo: {
          name: "chat_pro_repository_mcp",
          title: "Chat Pro Repository MCP",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      }), this.initializeTimeoutMs);
      await this.sendNotification("initialized", {});
      this.initialized = true;
    } catch {
      this.rejectPending();
      this.channel = undefined;
      this.initialized = false;
      await channel.close().catch(() => undefined);
      throw providerUnavailable();
    }
  }

  private async sendRequest(method: string, params: JsonRecord): Promise<unknown> {
    const channel = this.channel;
    if (!channel) throw providerUnavailable();
    const id = this.nextRequestId++;
    const key = rpcIdKey(id);
    const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
      this.pending.set(key, { method, resolve: resolvePromise, reject: rejectPromise });
    });
    try {
      await channel.send(JSON.stringify({ method, id, params }));
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
    return response;
  }

  private async sendNotification(method: string, params: JsonRecord): Promise<void> {
    const channel = this.channel;
    if (!channel) throw providerUnavailable();
    await channel.send(JSON.stringify({ method, params }));
  }

  private receive(raw: string): void {
    if (Buffer.byteLength(raw, "utf8") > MAX_APP_SERVER_MESSAGE_BYTES) {
      this.connectionLost();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      this.connectionLost();
      return;
    }
    if (!isRecord(value)) return;
    if ((typeof value.id === "number" || typeof value.id === "string") && ("result" in value || "error" in value) && !("method" in value)) {
      const pending = this.pending.get(rpcIdKey(value.id));
      if (!pending) return;
      this.pending.delete(rpcIdKey(value.id));
      if ("error" in value) pending.reject(new CodexAppServerRpcResponseError());
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string") return;
    const params = isRecord(value.params) ? value.params : {};
    const message = (typeof value.id === "number" || typeof value.id === "string")
      ? { id: value.id, method: value.method, params } satisfies CodexAppServerServerRequest
      : { method: value.method, params } satisfies CodexAppServerNotification;
    if (this.barrierActive) {
      this.bufferedMessages.push(message);
      return;
    }
    void this.dispatchOwnerMessage(message);
  }

  private async dispatchOwnerMessage(
    message: CodexAppServerNotification | CodexAppServerServerRequest
  ): Promise<void> {
    const attempts = !("id" in message) && message.method === "turn/completed" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if ("id" in message) {
          await this.resolveServerRequest(message);
          return;
        }
        await this.sink.handleNotification(message);
        return;
      } catch {
        if (attempt + 1 < attempts) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, TERMINAL_SINK_RETRY_MS));
          continue;
        }
        // Owner sink failures keep the private attempt in-flight. They never
        // authorize turn replay or a fallback response to approval requests.
      }
    }
  }

  private async resolveServerRequest(request: CodexAppServerServerRequest): Promise<void> {
    let response: { id: JsonRpcId; result: unknown } | {
      id: JsonRpcId;
      error: { code: number; message: string };
    };
    try {
      const disposition = await this.sink.handleServerRequest(request);
      response = !disposition.handled
        ? { id: request.id, error: { code: -32601, message: "Server request method is not supported." } }
        : "error" in disposition
          ? { id: request.id, error: disposition.error }
          : { id: request.id, result: disposition.result };
    } catch {
      response = {
        id: request.id,
        error: { code: -32603, message: "Server request could not be resolved safely." }
      };
    }
    try {
      await this.channel?.send(JSON.stringify(response));
    } catch {
      // A failed response write has unknown connection effect. Never replay it
      // or convert it into an approval on another connection.
    }
  }

  private connectionLost(): void {
    if (!this.channel && !this.initialized) return;
    this.channel = undefined;
    this.initialized = false;
    this.rejectPending();
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("Codex App Server connection closed."));
    this.pending.clear();
  }
}

export class UnixWebSocketMessageChannel implements CodexAppServerMessageChannel {
  private socket?: WebSocket;

  constructor(private readonly socketPath: string) {}

  async open(handlers: { message(value: string): void; close(): void; error(): void }): Promise<void> {
    const before = await assertSafeControlSocket(this.socketPath);
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(this.socketPath),
      maxPayload: MAX_APP_SERVER_MESSAGE_BYTES,
      perMessageDeflate: false
    });
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) handlers.message(data.toString());
    });
    socket.on("close", handlers.close);
    socket.on("error", handlers.error);
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once("open", resolvePromise);
        socket.once("error", rejectPromise);
        socket.once("unexpected-response", () => rejectPromise(new Error("Unexpected App Server response.")));
      });
      const after = await assertSafeControlSocket(this.socketPath);
      if (!sameSocketIdentity(before, after)) throw providerUnavailable();
    } catch {
      this.socket = undefined;
      socket.terminate();
      throw providerUnavailable();
    }
  }

  async send(value: string): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw providerUnavailable();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.send(value, (error) => error ? rejectPromise(error) : resolvePromise());
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolvePromise();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      socket.close();
    });
  }
}

export function defaultControlSocketPath(codexHome?: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(root)) throw providerUnavailable();
  return join(resolve(root), "app-server-control", "app-server-control.sock");
}

type ControlSocketIdentity = {
  parent_dev: number;
  parent_ino: number;
  socket_dev: number;
  socket_ino: number;
};

export async function assertSafeControlSocket(socketPath: string): Promise<ControlSocketIdentity> {
  try {
    const parent = dirname(socketPath);
    const [parentStat, socketStat, parentReal, socketReal] = await Promise.all([
      lstat(parent),
      lstat(socketPath),
      realpath(parent),
      realpath(socketPath)
    ]);
    await assertSafeSocketAncestors(parent);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !parentStat.isDirectory()
      || parentStat.isSymbolicLink()
      || (parentStat.mode & 0o077) !== 0
      || !socketStat.isSocket()
      || socketStat.isSymbolicLink()
      || (socketStat.mode & 0o077) !== 0
      || parentReal !== resolve(parent)
      || dirname(socketReal) !== parentReal
      || (uid !== undefined && (parentStat.uid !== uid || socketStat.uid !== uid))
    ) {
      throw new Error("unsafe socket");
    }
    return {
      parent_dev: parentStat.dev,
      parent_ino: parentStat.ino,
      socket_dev: socketStat.dev,
      socket_ino: socketStat.ino
    };
  } catch {
    throw providerUnavailable();
  }
}

async function assertSafeSocketAncestors(start: string): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let current = resolve(start);
  for (;;) {
    const stat = await lstat(current);
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || (stat.mode & 0o022) !== 0
      || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)
    ) {
      throw new Error("unsafe socket ancestor");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sameSocketIdentity(left: ControlSocketIdentity, right: ControlSocketIdentity): boolean {
  return left.parent_dev === right.parent_dev
    && left.parent_ino === right.parent_ino
    && left.socket_dev === right.socket_dev
    && left.socket_ino === right.socket_ino;
}

function providerUnavailable(): RepoReaderError {
  return new RepoReaderError(
    "RUNNER_PROVIDER_UNAVAILABLE",
    "The owner Codex App Server control connection is unavailable."
  );
}

function boundedInitializeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new Error("Codex App Server initialize timeout must be between 100 and 30000 milliseconds.");
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Codex App Server initialization timed out.")), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rpcIdKey(value: JsonRpcId): string {
  return `${typeof value}:${String(value)}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
