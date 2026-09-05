import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TaskMessagingConfigSchema, type CodexTaskMessageGrant } from "../src/config/task-messaging.js";
import { TaskMessageResultSchema, TaskMessageSendInputSchema, type TaskMessageSendInput } from "../src/contracts/task-messaging.contract.js";
import { CodexAppServerControlRpc, type CodexAppServerMessageChannel } from "../src/delegation/codex-app-server-control-rpc.js";
import { CodexAppServerRunSink } from "../src/delegation/codex-app-server-run-sink.js";
import { AppServerTaskMessageTransport } from "../src/messaging/app-server-transport.js";
import { TaskMessageStore, messageInputDigest } from "../src/messaging/message-store.js";
import { createMcpServer } from "../src/register.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { TaskMessagingService } from "../src/services/task-messaging-service.js";
import { canonicalSha256 } from "../src/task-runtime/canonical-json.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";

type WireRequest = { id?: number; method: string; params: Record<string, unknown> };
type ItemEntry = { turnId: string; item: { type: string; id: string; name: string; namespace: null; output: string } };
type FixtureThread = Record<string, unknown> & { id: string; status: { type: string } };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Only the wire peer is simulated: tests exercise the real JSON-RPC client, production
// transport, owner request sink, config/registry, private disk store, service and MCP path.
class ProtocolPeer implements CodexAppServerMessageChannel {
  requests: WireRequest[] = [];
  replies: Record<string, unknown>[] = [];
  threads = new Map<string, FixtureThread>();
  items = new Map<string, ItemEntry[]>();
  failRead = false;
  hideItems = false;
  disconnectAfterAccept = false;
  rejectStart = false;
  mismatchOutput = false;
  duplicateOutput = false;
  repeatCursor = false;
  noStartReply = false;
  private handlers?: Parameters<CodexAppServerMessageChannel["open"]>[0];
  async open(handlers: Parameters<CodexAppServerMessageChannel["open"]>[0]): Promise<void> { this.handlers = handlers; }
  async close(): Promise<void> { this.handlers?.close(); }
  async send(raw: string): Promise<void> {
    const request = JSON.parse(raw) as WireRequest;
    if (!request.method) { this.replies.push(JSON.parse(raw)); return; }
    this.requests.push(request);
    if (request.id === undefined) return;
    const respond = (result: unknown) => this.handlers!.message(JSON.stringify({ id: request.id, result }));
    const error = () => this.handlers!.message(JSON.stringify({ id: request.id, error: { code: -32602, message: "Rejected" } }));
    const id = String(request.params.threadId);
    if (request.method === "initialize") { respond({}); return; }
    if (request.method === "thread/read") {
      if (this.failRead || !this.threads.has(id)) { error(); return; }
      const turns = (this.items.get(id) ?? []).map((entry) => ({ id: entry.turnId, status: "completed", items: [entry.item] }));
      respond({ thread: { ...this.threads.get(id), turns: request.params.includeTurns ? turns : [] } }); return;
    }
    if (request.method === "thread/items/list") {
      let data = this.hideItems ? [] : this.items.get(id) ?? [];
      if (request.params.turnId) data = data.filter((item) => item.turnId === request.params.turnId);
      if (this.mismatchOutput) data = data.map((entry) => ({ ...entry, item: { ...entry.item, output: entry.item.output.replace("Status is ready", "Changed payload") } }));
      if (this.duplicateOutput) data = [...data, ...data];
      respond({ data, nextCursor: this.repeatCursor ? "same-cursor" : null }); return;
    }
    if (request.method === "turn/start") {
      if (this.rejectStart) { error(); return; }
      const turnId = `turn-${this.starts.length}`;
      const output = request.params.toolOutput as { name: string; namespace: null; output: string };
      const entry = { turnId, item: { type: "functionCallOutput", id: `item-${turnId}`, ...output } };
      this.items.set(id, [...this.items.get(id) ?? [], entry]);
      if (this.disconnectAfterAccept) { this.handlers!.close(); return; }
      if (!this.noStartReply) respond({ turn: { id: turnId, status: "inProgress", items: [] } });
      return;
    }
    throw new Error(`Forbidden production method: ${request.method}`);
  }
  get starts(): WireRequest[] { return this.requests.filter((request) => request.method === "turn/start"); }
  requestApproval(): void {
    this.handlers!.message(JSON.stringify({ id: 900, method: "item/permissions/requestApproval", params: {
      threadId: "00000000-0000-7000-8000-000000000001", turnId: "turn-1", itemId: "item-approval", startedAtMs: 1,
      cwd: "/fixture", permissions: { network: { enabled: true } }
    } }));
  }
}

async function fixture(options: { enabled?: boolean; second?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repo-task-messaging-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, "source"); const targetRoot = join(root, "dependency");
  await mkdir(repoRoot); await mkdir(targetRoot);
  const grant: CodexTaskMessageGrant = {
    recipient_id: "dependency-a", source_repo_id: "source", owner_uid: process.getuid!(),
    relationship: "dependency", modes: ["notify", "continue"], namespace: "codex_ui_task",
    target_id: "00000000-0000-7000-8000-000000000001", session_id: "00000000-0000-7000-8000-000000000001", created_at: 42,
    cwd: targetRoot, project_id: "project-a", model_provider: "fixture-provider", source: "vscode"
  };
  const grants = options.second ? [grant, { ...grant, recipient_id: "dependency-b", target_id: "00000000-0000-7000-8000-000000000002", session_id: "00000000-0000-7000-8000-000000000002" }] : [grant];
  const registry = await RootRegistry.fromConfig({
    repos: [{ repo_id: "source", display_name: "Source", root: repoRoot, allow_non_git: true }],
    runtime_root: join(root, "runtime"), limits: {}, task_messaging: { enabled: options.enabled ?? true, grants }
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const peer = new ProtocolPeer();
  for (const binding of grants) peer.threads.set(binding.target_id, {
    id: binding.target_id, sessionId: binding.session_id, createdAt: binding.created_at,
    cwd: binding.cwd, projectId: binding.project_id, modelProvider: binding.model_provider,
    source: binding.source, ephemeral: false, historyMode: "paginated", status: { type: "idle" },
    canAcceptDirectInput: true, model: "preserved-model", reasoningEffort: "preserved-effort"
  });
  const create = () => {
    const rpc = new CodexAppServerControlRpc(new CodexAppServerRunSink(registry, bundle.tasks), { channel_factory: () => peer });
    cleanups.push(() => rpc.close());
    return new TaskMessagingService(registry, new AppServerTaskMessageTransport(rpc, 100));
  };
  const service = create();
  const input: TaskMessageSendInput = {
    repo_id: "source", operation_id: "operation-1", message_id: "message-1", mode: "continue",
    summary: "Status is ready", evidence: [],
    recipients: grants.map((entry) => ({ recipient_id: entry.recipient_id, expected_binding_sha256: canonicalSha256(entry) }))
  };
  return { root, grant, grants, registry, peer, create, service, input };
}

describe("bounded existing-task messaging through the production adapter", () => {
  test("concurrent duplicate invocations share the durable message boundary", async () => {
    const f = await fixture();
    const results = await Promise.all([f.service.send(f.input), f.create().send({ ...f.input, operation_id: "operation-2" })]);
    expect(results.every((result) => result.recipients[0]!.state === "persistence_verified")).toBe(true);
    expect(f.peer.starts).toHaveLength(1);
  });

  test("precontact fsync failure sends nothing and cannot bypass durable uncertainty", async () => {
    const f = await fixture();
    const original = SecureRuntimeFs.prototype.atomicWrite;
    let failed = false;
    vi.spyOn(SecureRuntimeFs.prototype, "atomicWrite").mockImplementation(async function (this: SecureRuntimeFs, path, content, options) {
      if (!failed && path.startsWith("messaging/fences/")) { failed = true; throw new Error("fixture fsync failure"); }
      return original.call(this, path, content, options);
    });
    await expect(f.service.send(f.input)).rejects.toThrow("fixture fsync failure");
    await f.create().send({ ...f.input, operation_id: "operation-2" });
    expect(f.peer.starts).toHaveLength(0);
  });

  test("lost accepted-state write retains the first effect and continues independent fan-out", async () => {
    const f = await fixture({ second: true });
    const original = SecureRuntimeFs.prototype.atomicWrite;
    let failed = false;
    vi.spyOn(SecureRuntimeFs.prototype, "atomicWrite").mockImplementation(async function (this: SecureRuntimeFs, path, content, options) {
      if (!failed && path.startsWith("messaging/messages/") && String(content).includes('"state":"accepted"')) {
        failed = true; throw new Error("fixture accepted-state write failure");
      }
      return original.call(this, path, content, options);
    });
    const result = await f.service.send(f.input);
    expect(result.recipients.map((entry) => entry.state)).toEqual(["persistence_verified", "persistence_verified"]);
    await f.create().send({ ...f.input, operation_id: "operation-2" });
    expect(f.peer.starts).toHaveLength(2);
  });
  test("resolves an existing unmanaged cross-repository UI task and preserves native identity/configuration", async () => {
    const f = await fixture();
    expect(await f.service.resolve({ repo_id: "source", recipient_id: "dependency-a" })).toMatchObject({ continuation_supported: true, notification_supported: false, status: "idle" });
    const before = structuredClone(f.peer.threads.get(f.grant.target_id));
    const result = await f.service.send(f.input);
    expect(TaskMessageResultSchema.parse(result).recipients[0]).toMatchObject({ state: "persistence_verified", acknowledgement: "unobserved", replay_allowed: false });
    expect(f.peer.threads.get(f.grant.target_id)).toEqual(before);
    expect(f.peer.starts[0]!.params).toEqual({ threadId: f.grant.target_id, input: [], toolOutput: {
      name: "repo_send_task_message", namespace: null, output: expect.any(String)
    } });
    expect(JSON.parse((f.peer.starts[0]!.params.toolOutput as { output: string }).output)).toMatchObject({ source: { kind: "repository_mcp_tool", repo_id: "source" }, authority: expect.stringContaining("no new owner approval") });
    expect(JSON.stringify(result)).not.toContain(f.grant.target_id);
    expect(JSON.stringify(result)).not.toContain(f.grant.cwd);
    expect(await new SecureRuntimeFs(f.registry.runtimeRoot).listDirectory("tasks", 10)).toEqual([]);
  });

  test("passive notification never opens a connection, wakes, resumes, steers or injects", async () => {
    const f = await fixture();
    expect((await f.service.send({ ...f.input, mode: "notify" })).recipients[0]).toMatchObject({ state: "not_delivered", reason: "passive_transport_unverified" });
    expect(f.peer.requests).toEqual([]);
  });

  test.each(["notLoaded", "systemError"])("does not move ownership of %s recipients", async (status) => {
    const f = await fixture(); f.peer.threads.get(f.grant.target_id)!.status.type = status;
    const result = await f.service.send(f.input);
    expect(result.recipients[0]!.state).toBe("not_delivered"); expect(f.peer.starts).toHaveLength(0);
    expect(f.peer.requests.every((request) => ["initialize", "initialized", "thread/read"].includes(request.method))).toBe(true);
  });

  test("explicit continuation admits active-turn feed and never calls steer", async () => {
    const f = await fixture(); f.peer.threads.get(f.grant.target_id)!.status.type = "active";
    expect((await f.service.send(f.input)).recipients[0]!.state).toBe("persistence_verified");
    expect(f.peer.starts).toHaveLength(1);
  });

  test.each([false, null])("requires positive direct-input capability (%s)", async (value) => {
    const f = await fixture(); f.peer.threads.get(f.grant.target_id)!.canAcceptDirectInput = value;
    expect((await f.service.send(f.input)).recipients[0]!.reason).toBe("direct_input_unavailable"); expect(f.peer.starts).toHaveLength(0);
  });

  test.each(["id", "sessionId", "cwd", "projectId", "createdAt", "modelProvider", "source"])("rejects mismatched first-party %s", async (key) => {
    const f = await fixture(); f.peer.threads.get(f.grant.target_id)![key] = key === "createdAt" ? 43 : "foreign";
    expect((await f.service.send(f.input)).recipients[0]!.reason).toBe("binding_mismatch"); expect(f.peer.starts).toHaveLength(0);
  });

  test("disabled and unknown-recipient states make no transport contact", async () => {
    const f = await fixture({ enabled: false });
    expect((await f.service.resolve({ repo_id: "source", recipient_id: "dependency-a" })).reason).toBe("disabled");
    await expect(f.service.send(f.input)).rejects.toMatchObject({ code: "TASK_MESSAGE_DENIED" });
    expect(f.peer.requests).toEqual([]);
  });

  test("rejects wrong owner, broadened scope, stale and ambiguous grants", async () => {
    const f = await fixture();
    await expect(f.service.send({ ...f.input, recipients: [{ recipient_id: "unknown", expected_binding_sha256: "a".repeat(64) }] })).rejects.toMatchObject({ code: "TASK_MESSAGE_DENIED" });
    await expect(f.service.send({ ...f.input, recipients: [{ recipient_id: "dependency-a", expected_binding_sha256: "a".repeat(64) }] })).rejects.toMatchObject({ code: "TASK_MESSAGE_DENIED" });
    expect(TaskMessagingConfigSchema.safeParse({ enabled: true, grants: [f.grant, { ...f.grant }] }).success).toBe(false);
    const registry = await RootRegistry.fromConfig({ repos: [{ repo_id: "source", display_name: "Source", root: join(f.root, "source"), allow_non_git: true }], limits: {}, runtime_root: f.registry.runtimeRoot,
      task_messaging: { enabled: true, grants: [{ ...f.grant, owner_uid: process.getuid!() + 1 }] } });
    const service = new TaskMessagingService(registry, new AppServerTaskMessageTransport({ request: async () => { throw new Error("must not contact"); } }));
    expect((await service.resolve({ repo_id: "source", recipient_id: "dependency-a" })).reason).toBe("not_authorized");
    expect(f.peer.requests).toEqual([]);
  });

  test.each(["chatgpt_task", "managed_app_server_run"] as const)("keeps %s a separate unsupported namespace", async (namespace) => {
    const f = await fixture();
    const grant = { recipient_id: "other", source_repo_id: "source", owner_uid: process.getuid!(), relationship: "parent" as const, modes: ["continue" as const], namespace, target_id: "not-a-native-codex-task" };
    const registry = await RootRegistry.fromConfig({ repos: [{ repo_id: "source", display_name: "Source", root: join(f.root, "source"), allow_non_git: true }], limits: {}, runtime_root: f.registry.runtimeRoot, task_messaging: { enabled: true, grants: [grant] } });
    const service = new TaskMessagingService(registry, new AppServerTaskMessageTransport({ request: async () => { throw new Error("must not contact"); } }));
    expect((await service.send({ ...f.input, recipients: [{ recipient_id: "other", expected_binding_sha256: canonicalSha256(grant) }] })).recipients[0]!.reason).toBe("unsupported_namespace");
  });

  test("preserves acceptance separately from persistence and reconciles after restart without resend", async () => {
    const f = await fixture(); f.peer.hideItems = true;
    expect((await f.service.send(f.input)).recipients[0]).toMatchObject({ state: "accepted", reason: "readback_unavailable" });
    f.peer.hideItems = false;
    expect((await f.create().read({ repo_id: "source", message_id: "message-1" })).recipients[0]!.state).toBe("persistence_verified");
    expect((await f.service.send({ ...f.input, operation_id: "operation-2" })).recipients[0]!.state).toBe("persistence_verified");
    expect(f.peer.starts).toHaveLength(1);
  });

  test("disconnect after acceptance is query-reconciled with no duplicate turn", async () => {
    const f = await fixture(); f.peer.disconnectAfterAccept = true;
    expect((await f.service.send(f.input)).recipients[0]!.state).toBe("persistence_verified");
    expect(f.peer.starts).toHaveLength(1);
    await f.create().send({ ...f.input, operation_id: "operation-2" }); expect(f.peer.starts).toHaveLength(1);
  });

  test("unresolved effect blocks new operation and message IDs and remains visible", async () => {
    const f = await fixture(); f.peer.disconnectAfterAccept = true; f.peer.hideItems = true;
    expect((await f.service.send(f.input)).recipients[0]!.state).toBe("uncertain");
    await f.create().send({ ...f.input, operation_id: "operation-2" });
    expect((await f.create().send({ ...f.input, message_id: "new-message", operation_id: "operation-3" })).recipients[0]!.reason).toBe("prior_message_unresolved");
    expect(f.peer.starts).toHaveLength(1);
  });

  test("timeout after accepted request retains a no-replay fence", async () => {
    const f = await fixture(); f.peer.noStartReply = true; f.peer.hideItems = true;
    expect((await f.service.send(f.input)).recipients[0]!.state).toBe("uncertain");
    await f.service.send(f.input); expect(f.peer.starts).toHaveLength(1);
  });

  test.each(["mismatchOutput", "duplicateOutput", "repeatCursor"] as const)("retains %s readback uncertainty", async (field) => {
    const f = await fixture(); f.peer[field] = true;
    const result = await f.service.send(f.input);
    expect(result.recipients[0]!.state).toBe("accepted");
    expect(result.recipients[0]!.reason).toBe(field === "repeatCursor" ? "readback_unavailable" : "readback_mismatch");
    expect(result.recipients[0]!.persisted_item_ref).toBeNull();
  });

  test("partial fan-out does not replay successful recipients and has no acknowledgement loop", async () => {
    const f = await fixture({ second: true }); f.peer.threads.get("00000000-0000-7000-8000-000000000002")!.status.type = "notLoaded";
    const result = await f.service.send(f.input);
    expect(result.recipients.map((entry) => entry.state)).toEqual(["persistence_verified", "not_delivered"]);
    await f.create().send({ ...f.input, operation_id: "operation-2" });
    await f.service.read({ repo_id: "source", message_id: "message-1" });
    expect(f.peer.starts).toHaveLength(1); expect(f.peer.starts[0]!.params.threadId).toBe("00000000-0000-7000-8000-000000000001");
  });

  test("rejects identity collisions and strict role, raw item, command and override inputs", async () => {
    const f = await fixture(); await f.service.send(f.input);
    await expect(f.service.send({ ...f.input, operation_id: "operation-2", summary: "Different" })).rejects.toMatchObject({ code: "TASK_MESSAGE_CONFLICT" });
    await expect(f.service.send({ ...f.input, message_id: "different" })).rejects.toMatchObject({ code: "TASK_MESSAGE_CONFLICT" });
    for (const key of ["role", "sender", "items", "toolOutput", "command", "url", "model", "effort", "sandbox", "approvalPolicy", "threadId", "acknowledge", "run_id"]) {
      expect(TaskMessageSendInputSchema.safeParse({ ...f.input, [key]: "spoof" }).success).toBe(false);
    }
    expect(TaskMessageSendInputSchema.safeParse({ ...f.input, recipients: Array.from({ length: 9 }, (_, i) => ({ recipient_id: `target-${i}`, expected_binding_sha256: "a".repeat(64) })) }).success).toBe(false);
    expect(f.peer.starts).toHaveLength(1);
  });

  test("rejects secret payloads and private locators before outbox or provider contact", async () => {
    const f = await fixture();
    await expect(f.service.send({ ...f.input, summary: "api_key=fixture-sensitive-value-12345" })).rejects.toMatchObject({ code: "SECRET_CANDIDATE_BLOCKED" });
    await expect(f.service.send({ ...f.input, evidence: [{ repo_id: "source", path: ".chatgpt/private.json" }] })).rejects.toMatchObject({ code: "TASK_MESSAGE_DENIED" });
    expect(f.peer.requests).toEqual([]);
  });

  test("known rejection remains no-send and offline targets are not delivered", async () => {
    const f = await fixture(); f.peer.rejectStart = true;
    expect((await f.service.send(f.input)).recipients[0]).toMatchObject({ state: "not_delivered", reason: "rejected" });
    f.peer.failRead = true;
    expect((await f.service.send({ ...f.input, message_id: "next", operation_id: "operation-next" })).recipients[0]!.state).toBe("not_delivered");
    expect(f.peer.starts).toHaveLength(1);
  });

  test("crash-durable precontact state blocks replay even when a turn ID is absent", async () => {
    const f = await fixture(); f.peer.hideItems = true;
    await f.service.send(f.input);
    const store = new TaskMessageStore(new SecureRuntimeFs(f.registry.runtimeRoot));
    const record = (await store.read(store.key("source", "message-1")))!;
    expect(record.input_sha256).toBe(messageInputDigest(f.input));
    delete record.recipients[0]!.turn_id;
    record.recipients[0]!.delivery.state = "uncertain";
    await store.write(record);
    await f.create().send({ ...f.input, operation_id: "new-operation" }); expect(f.peer.starts).toHaveLength(1);
    const raw = await readFile(join(f.registry.runtimeRoot, "messaging/messages", `${record.key}.json`), "utf8");
    expect(raw).toContain("forwarded_context_only");
  });

  test("legacy history readback rebinds persisted identity", async () => {
    const f = await fixture(); f.peer.threads.get(f.grant.target_id)!.historyMode = "legacy";
    expect((await f.service.send(f.input)).recipients[0]!.state).toBe("persistence_verified");
  });

  test("actual MCP registration enforces strict input and truthful mutation annotations", async () => {
    const f = await fixture();
    const server = createMcpServer({ registry: f.registry, taskMessaging: f.service });
    const client = new Client({ name: "messaging-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    cleanups.push(() => server.close()); cleanups.push(() => client.close());
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(69);
    expect(tools.tools.find((tool) => tool.name === "repo_send_task_message")!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect((await client.callTool({ name: "repo_send_task_message", arguments: { ...f.input, role: "user" } })).isError).toBe(true);
    expect((await client.callTool({ name: "repo_send_task_message", arguments: f.input })).isError).toBeUndefined();
    f.peer.requestApproval(); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.peer.replies.at(-1)).toHaveProperty("error");
    expect(f.peer.replies.at(-1)).not.toHaveProperty("result.permissions");
    expect(f.peer.starts).toHaveLength(1);
  });
});
