import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentContinuationInputSchema, AgentContinuationResultSchema } from "../src/contracts/agent-continuation.contract.js";
import {
  CodexAppServerAdapter,
  CodexAppServerTurnStartError,
  type CodexAppServerMethod,
  type CodexAppServerRpc
} from "../src/delegation/codex-app-server-adapter.js";
import { DelegationAttemptStore } from "../src/delegation/attempt-store.js";
import { DelegationInteractionStore } from "../src/delegation/interaction-store.js";
import { DelegationRunStore, runPaths } from "../src/delegation/run-store.js";
import { createMcpServer } from "../src/register.js";
import { TaskAgentContinuationRuntime } from "../src/services/agent-continuation-service.js";
import { AgentRunsService } from "../src/services/agent-runs-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { RootRegistry } from "../src/services/root-registry.js";
import {
  TaskRuntimeService,
  type BaseRepositoryLookup,
  type TaskRepositoryRegistrar
} from "../src/task-runtime/index.js";
import { runnerStatusBinding, writeQueuedV3Run, writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const RUN_ID = "2026-08-26T120000Z-continuation-fixture";
const THREAD_CANARY = "private-thread-canary-should-never-leak";
const TURN_CANARY = "private-turn-canary-should-never-leak";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Codex App Server continuation", () => {
  test("continues the same idle thread once without exact HEAD/tree inputs or Local authority overrides", async () => {
    const fixture = await continuationFixture();
    await writeFile(join(fixture.taskRoot, "README.md"), "# Child changed this tree after the original baseline\n", "utf8");
    const rpc = new RecordingAppServerRpc(fixture.taskRoot);
    const runtime = continuationRuntime(fixture, rpc);
    const server = createMcpServer({ registry: fixture.registry, agentContinuation: runtime });
    const client = new Client({ name: "continuation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "repo_continue_agent_run",
        arguments: continuationInput(fixture.repoId, "continue-operation-success")
      });
      expect(response.isError).toBeUndefined();
      const result = AgentContinuationResultSchema.parse(response.structuredContent);
      expect(result).toMatchObject({
        ok: true,
        repo_id: fixture.repoId,
        run_id: RUN_ID,
        operation_id: "continue-operation-success",
        accepted: true,
        turn_index: 2,
        revision: 8
      });
      expect(rpc.calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume", "turn/start"]);
      expect(rpc.calls[0]?.params).toEqual({ threadId: THREAD_CANARY, includeTurns: false });
      expect(rpc.calls[1]?.params).toEqual({ threadId: THREAD_CANARY });
      expect(rpc.calls[2]?.params).toEqual({
        threadId: THREAD_CANARY,
        input: [{ type: "text", text: "Continue with the reviewed correction.", text_elements: [] }]
      });
      expect(JSON.stringify(response)).not.toContain(THREAD_CANARY);
      expect(JSON.stringify(response)).not.toContain(TURN_CANARY);

      const session = await new DelegationInteractionStore(fixture.taskRoot).readSession(fixture.repoId, RUN_ID);
      const attempt = await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID);
      const operation = await fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-success");
      expect(session).toMatchObject({ thread_id: THREAD_CANARY, turn_index: 2 });
      expect(attempt).toMatchObject({ state: "in_flight", turn_index: 2, app_server_turn_id: TURN_CANARY });
      expect(operation).toMatchObject({ kind: "AGENT_CONTINUE", phase: "EXTERNAL_SUCCEEDED", effect_state: "PRESENT" });

      const observed = await client.callTool({
        name: "repo_agent_runs",
        arguments: { repo_id: fixture.repoId, run_id: RUN_ID }
      });
      expect(observed.structuredContent).toMatchObject({
        run: { result_presence: { result_json: true, reviewable: false } },
        next_tool_payloads: {}
      });
      const staleReview = await client.callTool({
        name: "repo_codex_review",
        arguments: { repo_id: fixture.repoId, run_id: RUN_ID }
      });
      expect(staleReview).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CODEX_REVIEW_NOT_ELIGIBLE" } }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("holds immediate completion notifications until running state is durably persisted", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "immediate_completion", async () => {
      const runs = new DelegationRunStore(fixture.taskRoot);
      const running = await runs.readStatus(RUN_ID);
      expect(running).toMatchObject({ status: "running", revision: 8, result_found: false });
      const attempts = new DelegationAttemptStore(fixture.taskRoot);
      const inFlight = await attempts.read(fixture.repoId, RUN_ID);
      expect(inFlight).toMatchObject({ state: "in_flight", turn_index: 2, app_server_turn_id: TURN_CANARY });
      await attempts.write({
        repo_id: fixture.repoId,
        run_id: RUN_ID,
        provider: "codex_app_server",
        operation: "resume",
        turn_index: 2,
        state: "settled",
        app_server_turn_id: TURN_CANARY,
        started_at: inFlight!.started_at
      });
      await runs.writeStatus({
        ...running!,
        status: "completed",
        revision: 9,
        completed_at: "2026-08-26T12:05:01.000Z",
        result_found: true
      });
    });

    const result = await continuationRuntime(fixture, rpc).continue(
      continuationInput(fixture.repoId, "continue-operation-immediate-completion")
    );

    expect(result).toMatchObject({
      revision: 8,
      next_tool_payloads: { repo_agent_runs: { wait_after_revision: 8 } }
    });
    await expect(new DelegationRunStore(fixture.taskRoot).readStatus(RUN_ID)).resolves.toMatchObject({
      status: "completed",
      revision: 9,
      result_found: true
    });
  });

  test("rejects an active App Server thread before resume or turn start", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "active");
    const runtime = continuationRuntime(fixture, rpc);
    await expect(runtime.continue(continuationInput(fixture.repoId, "continue-operation-active")))
      .rejects.toMatchObject({ code: "RUNNER_LOCK_ACTIVE" });
    expect(rpc.calls.map(({ method }) => method)).toEqual(["thread/read"]);
    await expect(fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-active"))
      .resolves.toMatchObject({ phase: "FAILED_PRECONTACT", effect_state: "NOT_STARTED" });
  });

  test("rejects a thread that remains not-loaded after resume", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "resume_not_loaded");
    const runtime = continuationRuntime(fixture, rpc);
    await expect(runtime.continue(continuationInput(fixture.repoId, "continue-operation-resume-not-loaded")))
      .rejects.toMatchObject({ code: "RUNNER_PROVIDER_FAILED" });
    expect(rpc.calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume"]);
    await expect(fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-resume-not-loaded"))
      .resolves.toMatchObject({ phase: "FAILED_PRECONTACT", effect_state: "NOT_STARTED" });
  });

  test("rejects implicit model fallback before turn start", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "model_mismatch");
    const runtime = continuationRuntime(fixture, rpc);
    await expect(runtime.continue(continuationInput(fixture.repoId, "continue-operation-model-mismatch")))
      .rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
    expect(rpc.calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume"]);
  });

  test("rejects same-run continuation after a formal review attestation", async () => {
    const fixture = await continuationFixture();
    await writeFile(
      join(fixture.taskRoot, `.chatgpt/codex-runs/${RUN_ID}/review.json`),
      '{"formal":"review"}\n',
      "utf8"
    );
    const rpc = new RecordingAppServerRpc(fixture.taskRoot);
    const runtime = continuationRuntime(fixture, rpc);
    await expect(runtime.continue(continuationInput(fixture.repoId, "continue-operation-reviewed")))
      .rejects.toMatchObject({ code: "RUNNER_POLICY_BLOCKED" });
    expect(rpc.calls).toEqual([]);
  });

  test("uses the existing operation ledger to reject exact duplicates and request conflicts", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot);
    const runtime = continuationRuntime(fixture, rpc);
    const input = continuationInput(fixture.repoId, "continue-operation-duplicate");
    await runtime.continue(input);
    const callsAfterSuccess = rpc.calls.length;

    await expect(runtime.continue(input)).rejects.toMatchObject({ code: "TASK_OPERATION_ALREADY_COMPLETED" });
    await expect(runtime.continue({ ...input, instruction: "Different bytes under the same operation id." }))
      .rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
    expect(rpc.calls).toHaveLength(callsAfterSuccess);
  });

  test("restores settled attempt evidence after a confirmed no-start so a new operation can continue", async () => {
    const fixture = await continuationFixture();
    const rejectedRpc = new RecordingAppServerRpc(fixture.taskRoot, "start_not_started");
    const rejectedRuntime = continuationRuntime(fixture, rejectedRpc);
    const previousAttempt = await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID);

    await expect(rejectedRuntime.continue(continuationInput(fixture.repoId, "continue-operation-not-started")))
      .rejects.toMatchObject({ code: "RUNNER_PROVIDER_FAILED" });
    expect(await fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-not-started")).toMatchObject({
      phase: "FAILED_KNOWN_AFTER_CONTACT",
      effect_state: "ABSENT"
    });
    expect(await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID)).toEqual(previousAttempt);

    const successorRpc = new RecordingAppServerRpc(fixture.taskRoot);
    await continuationRuntime(fixture, successorRpc).continue(
      continuationInput(fixture.repoId, "continue-operation-after-not-started")
    );
    expect(successorRpc.calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume", "turn/start"]);
  });

  test("keeps the in-flight guard when the confirmed no-start disposition cannot be persisted", async () => {
    const fixture = await continuationFixture();
    const originalWrite = fixture.tasks.states.writeOperation.bind(fixture.tasks.states);
    const writeSpy = vi.spyOn(fixture.tasks.states, "writeOperation").mockImplementation(async (value) => {
      if (value.phase === "FAILED_KNOWN_AFTER_CONTACT") throw new Error("injected operation write failure");
      return originalWrite(value);
    });
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "start_not_started");
    const runtime = continuationRuntime(fixture, rpc);
    const input = continuationInput(fixture.repoId, "continue-operation-no-start-ledger-failure");
    try {
      await expect(runtime.continue(input)).rejects.toMatchObject({ code: "EXTERNAL_EFFECT_UNKNOWN" });
      await expect(new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID)).resolves.toMatchObject({
        state: "in_flight",
        turn_index: 2
      });
      const callsAfterFailure = rpc.calls.length;
      await expect(runtime.continue({ ...input, operation_id: "continue-operation-after-ledger-failure" }))
        .rejects.toMatchObject({ code: "RUNNER_LOCK_ACTIVE" });
      expect(rpc.calls).toHaveLength(callsAfterFailure);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("restores the prior attempt when contact-state persistence fails before turn start", async () => {
    const fixture = await continuationFixture();
    const previousAttempt = await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID);
    const originalWrite = fixture.tasks.states.writeOperation.bind(fixture.tasks.states);
    let injected = false;
    const writeSpy = vi.spyOn(fixture.tasks.states, "writeOperation").mockImplementation(async (value) => {
      if (!injected && value.phase === "EXTERNAL_CONTACTED") {
        injected = true;
        throw new Error("injected contact-state failure");
      }
      return originalWrite(value);
    });
    const rpc = new RecordingAppServerRpc(fixture.taskRoot);
    try {
      await expect(continuationRuntime(fixture, rpc).continue(
        continuationInput(fixture.repoId, "continue-operation-contact-state-failure")
      )).rejects.toMatchObject({ code: "RUNNER_INTERACTION_INVALID" });
      expect(rpc.calls.map(({ method }) => method)).toEqual(["thread/read", "thread/resume"]);
      await expect(new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID))
        .resolves.toEqual(previousAttempt);
      await expect(fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-contact-state-failure"))
        .resolves.toMatchObject({ phase: "FAILED_PRECONTACT", effect_state: "NOT_STARTED" });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("records unknown turn-start effect and forbids blind replay under the same or a new operation", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "start_unknown");
    const runtime = continuationRuntime(fixture, rpc);
    const input = continuationInput(fixture.repoId, "continue-operation-unknown");

    await expect(runtime.continue(input)).rejects.toMatchObject({ code: "EXTERNAL_EFFECT_UNKNOWN" });
    expect(await fixture.tasks.states.readOperation(fixture.taskId, input.operation_id)).toMatchObject({
      phase: "UNKNOWN_AFTER_CONTACT",
      effect_state: "UNKNOWN"
    });
    expect(await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID)).toMatchObject({
      state: "in_flight",
      turn_index: 2
    });
    const callsAfterUnknown = rpc.calls.length;
    await expect(runtime.continue(input)).rejects.toMatchObject({ code: "TASK_OPERATION_BLOCKED" });
    await expect(runtime.continue({ ...input, operation_id: "continue-operation-after-unknown" }))
      .rejects.toMatchObject({ code: "RUNNER_LOCK_ACTIVE" });
    expect(rpc.calls).toHaveLength(callsAfterUnknown);
    const observed = await new AgentRunsService(fixture.taskRoot, new PathSandbox(fixture.taskRoot)).read({
      repo_id: fixture.repoId,
      run_id: RUN_ID
    });
    expect(observed.run?.warnings).toContain("AGENT_RUN_EFFECT_UNKNOWN_NO_REPLAY");
    expect(observed.run?.result_presence.reviewable).toBe(false);
  });

  test("suppresses stale results when status is missing but an in-flight attempt remains", async () => {
    const fixture = await continuationFixture();
    await new DelegationAttemptStore(fixture.taskRoot).write({
      repo_id: fixture.repoId,
      run_id: RUN_ID,
      provider: "codex_app_server",
      operation: "resume",
      turn_index: 2,
      state: "in_flight",
      started_at: "2026-08-26T12:05:00.000Z"
    });
    await rm(join(fixture.taskRoot, runPaths(RUN_ID).status_path));

    const observed = await new AgentRunsService(fixture.taskRoot, new PathSandbox(fixture.taskRoot)).read({
      repo_id: fixture.repoId,
      run_id: RUN_ID
    });
    expect(observed.run?.warnings).toContain("AGENT_RUN_EFFECT_UNKNOWN_NO_REPLAY");
    expect(observed.run?.result_presence.reviewable).toBe(false);

    const server = createMcpServer({ registry: fixture.registry });
    const client = new Client({ name: "continuation-stale-result-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const review = await client.callTool({
        name: "repo_codex_review",
        arguments: { repo_id: fixture.repoId, run_id: RUN_ID }
      });
      expect(review).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CODEX_REVIEW_NOT_ELIGIBLE" } }
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps private thread data and raw adapter errors out of public results and strict inputs", async () => {
    const fixture = await continuationFixture();
    const rpc = new RecordingAppServerRpc(fixture.taskRoot, "read_error");
    const runtime = continuationRuntime(fixture, rpc);
    const server = createMcpServer({ registry: fixture.registry, agentContinuation: runtime });
    const client = new Client({ name: "continuation-privacy-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({
        name: "repo_continue_agent_run",
        arguments: continuationInput(fixture.repoId, "continue-operation-private-error")
      });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({ error: { code: "RUNNER_PROVIDER_FAILED" } });
      expect(JSON.stringify(response)).not.toContain(THREAD_CANARY);
      expect(JSON.stringify(await fixture.tasks.states.readOperation(fixture.taskId, "continue-operation-private-error")))
        .not.toContain(THREAD_CANARY);

      const runs = await client.callTool({
        name: "repo_agent_runs",
        arguments: { repo_id: fixture.repoId, run_id: RUN_ID }
      });
      expect(JSON.stringify(runs)).not.toContain(THREAD_CANARY);
      expect(JSON.stringify(runs)).not.toContain(TURN_CANARY);

      for (const forbidden of [
        "thread_id",
        "model",
        "machine",
        "repository_path",
        "binding_id",
        "idempotency_key",
        "expected_head_sha",
        "expected_tree_sha"
      ]) {
        expect(AgentContinuationInputSchema.safeParse({
          ...continuationInput(fixture.repoId, "continue-operation-strict"),
          [forbidden]: "forbidden"
        }).success).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

type ContinuationFixture = {
  registry: RootRegistry;
  tasks: TaskRuntimeService;
  taskId: string;
  repoId: string;
  taskRoot: string;
};

async function continuationFixture(): Promise<ContinuationFixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "agent-continuation-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const worktreeRoot = join(parent, "worktrees");
  const runtimeRoot = join(parent, "runtime");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Agent Continuation Test");
  await git(ownerRoot, "config", "user.email", "agent-continuation@example.invalid");
  await writeFile(join(ownerRoot, "README.md"), "# Continuation fixture\n", "utf8");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const commit = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");

  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner",
      root: ownerRoot,
      writes: { enabled: true, allowed_globs: ["**"], denied_globs: [] },
      operations: { enabled: true },
      lifecycle: {
        kind: "local",
        authority: "write",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const lookup: BaseRepositoryLookup = {
    async getBaseRepository(repoId) {
      if (repoId !== "owner") throw new Error("Unknown fixture repository.");
      return { repo_id: "owner", root: ownerRoot, worktree_root: worktreeRoot };
    }
  };
  const registrar: TaskRepositoryRegistrar = {
    async registerTaskRepository(registration) {
      await registry.registerTaskRepo({
        task_id: registration.task_id,
        task_repo_id: registration.repo_id,
        base_repo_id: registration.base_repo_id,
        authority: registration.authority,
        branch: registration.branch,
        worktree: registration.root
      });
    },
    async unregisterTaskRepository(repoId) {
      if (registry.taskBinding(repoId)) registry.unregisterTaskRepo(repoId);
    }
  };
  const tasks = new TaskRuntimeService({
    runtimeRoot,
    baseRepositories: lookup,
    registrar,
    lock: { timeoutMs: 5_000, pollMs: 5 }
  });
  const taskId = "task-agent-continuation";
  const opened = await tasks.open({
    operation_id: "open-agent-continuation",
    task_id: taskId,
    base_repo_id: "owner",
    base_branch: "main",
    base_commit: commit,
    base_tree: tree,
    authority: "implement",
    goal: "Exercise a provider-free continuation bridge.",
    branch_slug: "agent-continuation"
  });
  const repoId = opened.repo_id;
  const taskRoot = registry.get(repoId).root;
  await writeQueuedV3Run(taskRoot, RUN_ID, { repo_id: repoId, runner: "codex_app_server" });
  await writeV3Result(taskRoot, RUN_ID);
  const now = () => new Date("2026-08-26T12:05:00.000Z");
  await new DelegationRunStore(taskRoot, { now }).writeStatus({
    ...runnerStatusBinding(RUN_ID, 3),
    repo_id: repoId,
    run_id: RUN_ID,
    runner: "codex_app_server",
    status: "completed",
    revision: 7,
    started_at: "2026-08-26T12:00:00.000Z",
    completed_at: "2026-08-26T12:04:00.000Z",
    result_found: true,
    head_before: null,
    head_after: null,
    worktree_fingerprint_before: null,
    worktree_fingerprint_after: null,
    changed_paths: [],
    validation: { status: "missing", profile: null, artifact_path: null },
    commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
    warnings: []
  });
  await new DelegationInteractionStore(taskRoot, now).writeSession({
    repo_id: repoId,
    run_id: RUN_ID,
    provider: "codex_app_server",
    thread_id: THREAD_CANARY,
    model: "fixture-model",
    turn_index: 1,
    active_runtime_ms: 500,
    last_consumed_reply_turn_index: null,
    created_at: "2026-08-26T12:00:00.000Z"
  });
  await new DelegationAttemptStore(taskRoot, now).write({
    repo_id: repoId,
    run_id: RUN_ID,
    provider: "codex_app_server",
    operation: "start",
    turn_index: 1,
    state: "settled",
    started_at: "2026-08-26T12:00:00.000Z"
  });
  return { registry, tasks, taskId, repoId, taskRoot };
}

function continuationRuntime(fixture: ContinuationFixture, rpc: CodexAppServerRpc): TaskAgentContinuationRuntime {
  return new TaskAgentContinuationRuntime(
    fixture.registry,
    fixture.tasks,
    new CodexAppServerAdapter(rpc),
    () => new Date("2026-08-26T12:05:00.000Z")
  );
}

function continuationInput(repoId: string, operationId: string) {
  return AgentContinuationInputSchema.parse({
    repo_id: repoId,
    run_id: RUN_ID,
    operation_id: operationId,
    expected_revision: 7,
    instruction: "Continue with the reviewed correction."
  });
}

class RecordingAppServerRpc implements CodexAppServerRpc {
  readonly calls: Array<{ method: CodexAppServerMethod; params: Record<string, unknown> }> = [];
  private readonly pendingNotifications: Array<() => Promise<void>> = [];
  private notificationBarrierActive = false;

  constructor(
    private readonly root: string,
    private readonly mode:
      | "idle"
      | "active"
      | "resume_not_loaded"
      | "model_mismatch"
      | "immediate_completion"
      | "start_unknown"
      | "start_not_started"
      | "read_error" = "idle",
    private readonly onNotification?: () => Promise<void>
  ) {}

  async withNotificationDeliveryBarrier<T>(action: () => Promise<T>): Promise<T> {
    if (this.notificationBarrierActive) throw new Error("Nested notification barrier.");
    this.notificationBarrierActive = true;
    try {
      return await action();
    } finally {
      this.notificationBarrierActive = false;
      for (const notification of this.pendingNotifications.splice(0)) await notification();
    }
  }

  async request(method: CodexAppServerMethod, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      if (this.mode === "read_error") throw new Error(`raw adapter failure ${THREAD_CANARY}`);
      return { thread: this.thread(this.mode === "active" ? "active" : "notLoaded") };
    }
    if (method === "thread/resume") {
      return {
        thread: this.thread(this.mode === "resume_not_loaded" ? "notLoaded" : "idle"),
        model: this.mode === "model_mismatch" ? "fallback-model" : "fixture-model",
        modelProvider: "fixture-provider",
        cwd: this.root
      };
    }
    if (!this.notificationBarrierActive) throw new Error("turn/start called without notification barrier");
    if (this.mode === "start_unknown") throw new Error(`disconnect after write ${THREAD_CANARY}`);
    if (this.mode === "start_not_started") throw new CodexAppServerTurnStartError("not_started");
    if (this.mode === "immediate_completion") {
      this.pendingNotifications.push(async () => {
        await this.onNotification?.();
      });
    }
    return { turn: { id: TURN_CANARY, status: "inProgress" } };
  }

  private thread(status: "notLoaded" | "idle" | "active") {
    return {
      id: THREAD_CANARY,
      modelProvider: "fixture-provider",
      cwd: this.root,
      status: status === "active" ? { type: "active", activeFlags: [] } : { type: status }
    };
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
