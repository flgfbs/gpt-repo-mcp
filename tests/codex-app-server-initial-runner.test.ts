import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexAppServerAdapter } from "../src/delegation/codex-app-server-adapter.js";
import {
  CodexAppServerControlRpc,
  type CodexAppServerMessageChannel
} from "../src/delegation/codex-app-server-control-rpc.js";
import { CodexAppServerRunSink } from "../src/delegation/codex-app-server-run-sink.js";
import { attemptPath, DelegationAttemptStore } from "../src/delegation/attempt-store.js";
import { DelegationDispatchStore, dispatchPaths } from "../src/delegation/dispatch-store.js";
import { DelegationInteractionStore, sessionPath } from "../src/delegation/interaction-store.js";
import { DelegationRunStore } from "../src/delegation/run-store.js";
import {
  CodexAppServerInitialRunner,
  type InitialRunnerConnection
} from "../src/services/codex-app-server-initial-runner.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { writeQueuedV3Run, writeV3Result } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const RUN_ID = "2026-08-28T120000Z-initial-app-server-runner";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex App Server initial runner", () => {
  test("starts one exact local thread and turn, then settles through the existing sink", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    const launched = await supervisor.scanOnce();

    expect(launched).toMatchObject({
      outcome: "launched",
      run_id: RUN_ID,
      result: {
        effect_state: "known_complete",
        provider_contact: "confirmed",
        terminal_state: "unknown",
        replay_allowed: false,
        outcome_code: "APP_SERVER_INITIAL_TURN_ACCEPTED"
      }
    });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toEqual([expect.objectContaining({
      params: {
        cwd: fixture.taskRoot,
        approvalPolicy: "never",
        permissions: ":workspace",
        serviceName: "chat_pro_repository_mcp_owner_runner"
      }
    })]);
    expect(channels[0]!.sent.find(({ method }) => method === "thread/start")?.params)
      .not.toHaveProperty("sandbox");
    expect(channels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(JSON.stringify(channels[0]!.sent)).not.toContain("fixture-model");

    const runs = new DelegationRunStore(fixture.taskRoot);
    const status = await runs.readStatus(RUN_ID);
    const session = await new DelegationInteractionStore(fixture.taskRoot).readSession(fixture.repoId, RUN_ID);
    const attempt = await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID);
    expect(status).toMatchObject({ status: "running", revision: 1, result_found: false });
    expect(session).toMatchObject({
      provider: "codex_app_server",
      thread_id: "private-initial-thread",
      model: "fixture-model",
      turn_index: 1
    });
    expect(attempt).toMatchObject({
      operation: "start",
      state: "in_flight",
      app_server_turn_id: "private-initial-turn",
      turn_index: 1
    });

    await writeV3Result(fixture.taskRoot, RUN_ID);
    channels[0]!.notify("turn/completed", {
      turn: { id: "private-initial-turn", status: "completed" }
    });
    await vi.waitFor(async () => expect(await runs.readStatus(RUN_ID)).toMatchObject({
      status: "completed",
      result_found: true,
      revision: 2
    }));
    await vi.waitFor(async () => expect(await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID))
      .toMatchObject({ state: "settled" }));
    await vi.waitFor(async () => expect(await readFile(join(fixture.taskRoot, `.chatgpt/codex-runs/${RUN_ID}/runner.events.jsonl`), "utf8"))
      .toContain('"event_type":"completed"'));
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "idle" });
    expect(channels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await runner.close();
  });

  test("rebinds an exact in-flight turn after restart without starting another thread or turn", async () => {
    const fixture = await runnerFixture();
    const firstChannels: FakeAppServerChannel[] = [];
    const firstRunner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, firstChannels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: firstRunner,
      mode: "external_worker"
    });
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "launched" });
    await firstRunner.close();

    const successorChannels: FakeAppServerChannel[] = [];
    const successor = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, successorChannels, "active")
    });
    const withLock = vi.spyOn(fixture.bundle.tasks.locks, "withLock");
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 1,
      rebound: 1,
      settled: 0,
      failed_closed: 0
    });
    expect(withLock.mock.calls.map(([lockId]) => lockId)).toEqual([
      "task:task-initial-runner-fixture",
      `agent-run:task-initial-runner-fixture:${RUN_ID}`
    ]);
    expect(successorChannels).toHaveLength(1);
    expect(successorChannels[0]!.sent.filter(({ method }) => method === "thread/read")).toHaveLength(1);
    expect(successorChannels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(0);
    expect(successorChannels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(0);

    await writeV3Result(fixture.taskRoot, RUN_ID);
    successorChannels[0]!.notify("turn/completed", {
      turn: { id: "private-initial-turn", status: "completed" }
    });
    const runs = new DelegationRunStore(fixture.taskRoot);
    await vi.waitFor(async () => expect(await runs.readStatus(RUN_ID)).toMatchObject({ status: "completed" }));
    await vi.waitFor(async () => expect(await new DelegationAttemptStore(fixture.taskRoot).read(fixture.repoId, RUN_ID))
      .toMatchObject({ state: "settled" }));
    await vi.waitFor(async () => expect(await readFile(join(fixture.taskRoot, `.chatgpt/codex-runs/${RUN_ID}/runner.events.jsonl`), "utf8"))
      .toContain('"event_type":"completed"'));
    await successor.close();
    withLock.mockRestore();
  });

  test("terminally blocks a crashed initial turn whose private turn id was never persisted", async () => {
    const fixture = await runnerFixture();
    const firstChannels: FakeAppServerChannel[] = [];
    const firstRunner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, firstChannels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: firstRunner,
      mode: "external_worker"
    });
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "launched" });
    await firstRunner.close();
    await rm(join(fixture.taskRoot, dispatchPaths(RUN_ID).result), { force: true });
    const attempts = new DelegationAttemptStore(fixture.taskRoot);
    const persistedAttempt = await attempts.read(fixture.repoId, RUN_ID);
    await attempts.write({
      repo_id: fixture.repoId,
      run_id: RUN_ID,
      provider: "codex_app_server",
      operation: "start",
      turn_index: 1,
      state: "in_flight",
      active_runtime_ms_before: 0,
      started_at: persistedAttempt!.started_at
    });

    const successorChannels: FakeAppServerChannel[] = [];
    const successor = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, successorChannels)
    });
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 1,
      rebound: 0,
      settled: 0,
      failed_closed: 1
    });
    expect(await new DelegationRunStore(fixture.taskRoot).readStatus(RUN_ID)).toMatchObject({
      status: "blocked_policy",
      warnings: expect.arrayContaining(["APP_SERVER_RESTART_BINDING_UNKNOWN", "UNKNOWN_EFFECT_NO_REPLAY"])
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "unknown",
      provider_contact: "unknown",
      terminal_state: "unknown",
      replay_allowed: false,
      outcome_code: "APP_SERVER_RESTART_BINDING_UNKNOWN"
    });
    expect(successorChannels).toHaveLength(0);
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 0,
      rebound: 0,
      settled: 0,
      failed_closed: 0
    });
    await successor.close();
  });

  test("terminally blocks a crashed claimed run without replaying App Server contact", async () => {
    const fixture = await runnerFixture();
    const firstChannels: FakeAppServerChannel[] = [];
    const firstRunner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, firstChannels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: firstRunner,
      mode: "external_worker"
    });
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "launched" });
    await firstRunner.close();
    const runs = new DelegationRunStore(fixture.taskRoot);
    const status = await runs.readStatus(RUN_ID);
    await Promise.all([
      rm(join(fixture.taskRoot, dispatchPaths(RUN_ID).result), { force: true }),
      rm(join(fixture.taskRoot, attemptPath(RUN_ID)), { force: true }),
      rm(join(fixture.taskRoot, sessionPath(RUN_ID)), { force: true })
    ]);
    await runs.writeStatus({
      ...status!,
      status: "claimed",
      revision: 0,
      completed_at: null
    });

    const successorChannels: FakeAppServerChannel[] = [];
    const successor = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, successorChannels)
    });
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 1,
      rebound: 0,
      settled: 0,
      failed_closed: 1
    });
    expect(await runs.readStatus(RUN_ID)).toMatchObject({
      status: "blocked_policy",
      warnings: expect.arrayContaining(["APP_SERVER_RESTART_BINDING_UNKNOWN", "UNKNOWN_EFFECT_NO_REPLAY"])
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "unknown",
      provider_contact: "unknown",
      terminal_state: "unknown",
      outcome_code: "APP_SERVER_RESTART_BINDING_UNKNOWN"
    });
    expect(successorChannels).toHaveLength(0);
    await successor.close();
  });

  test("settles a completed turn after restart outside the run lock and repairs missing launch evidence", async () => {
    const fixture = await runnerFixture();
    const firstChannels: FakeAppServerChannel[] = [];
    const firstRunner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, firstChannels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: firstRunner,
      mode: "external_worker"
    });
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "launched" });
    await firstRunner.close();
    await writeV3Result(fixture.taskRoot, RUN_ID);
    await rm(join(fixture.taskRoot, dispatchPaths(RUN_ID).result), { force: true });

    const successorChannels: FakeAppServerChannel[] = [];
    const successor = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, successorChannels, "settled")
    });
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 1,
      rebound: 0,
      settled: 1,
      failed_closed: 0
    });
    expect(await new DelegationRunStore(fixture.taskRoot).readStatus(RUN_ID)).toMatchObject({
      status: "completed",
      result_found: true
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "known_complete",
      provider_contact: "confirmed",
      terminal_state: "completed",
      outcome_code: "APP_SERVER_INITIAL_TURN_RECONCILED"
    });
    expect(successorChannels).toHaveLength(1);
    expect(successorChannels[0]!.closed).toBe(true);
    expect(successorChannels[0]!.sent.filter(({ method }) => method === "thread/read")).toHaveLength(1);
    expect(successorChannels[0]!.sent.filter(({ method }) => method === "thread/start" || method === "turn/start"))
      .toHaveLength(0);

    await rm(join(fixture.taskRoot, dispatchPaths(RUN_ID).result), { force: true });
    expect(await successor.reconcileRepository(fixture.repoId)).toEqual({
      examined: 0,
      rebound: 0,
      settled: 0,
      failed_closed: 0
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      terminal_state: "completed",
      outcome_code: "APP_SERVER_INITIAL_TURN_RECONCILED"
    });
    expect(successorChannels).toHaveLength(1);
    await successor.close();
  });

  test("does not adopt or retain a continuation turn owned by the HTTP bridge", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "launched" });

    const sessions = new DelegationInteractionStore(fixture.taskRoot);
    const attempts = new DelegationAttemptStore(fixture.taskRoot);
    const session = await sessions.readSession(fixture.repoId, RUN_ID);
    expect(session).not.toBeNull();
    await sessions.writeSession({ ...session!, turn_index: 2 });
    await attempts.write({
      repo_id: fixture.repoId,
      run_id: RUN_ID,
      provider: "codex_app_server",
      operation: "resume",
      turn_index: 2,
      state: "in_flight",
      app_server_turn_id: "private-continuation-turn",
      active_runtime_ms_before: 0,
      started_at: new Date().toISOString()
    });

    expect(await runner.reconcileRepository(fixture.repoId)).toEqual({
      examined: 1,
      rebound: 0,
      settled: 0,
      failed_closed: 0
    });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.closed).toBe(true);
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/read")).toHaveLength(0);
    await runner.close();
  });

  test("accepts the official omitted network-access default as disabled", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels, "missing-network-access")
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    expect(await supervisor.scanOnce()).toMatchObject({
      outcome: "launched",
      result: {
        effect_state: "known_complete",
        provider_contact: "confirmed",
        outcome_code: "APP_SERVER_INITIAL_TURN_ACCEPTED"
      }
    });
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(channels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    await runner.close();
  });

  test.each([
    ["network-enabled", "network-enabled"],
    ["non-workspace sandbox", "read-only-sandbox"],
    ["non-never approval policy", "on-request-approval"],
    ["missing active permission profile", "missing-active-profile"],
    ["different active permission profile", "wrong-active-profile"]
  ] as const)("rejects an unsafe %s thread-start response", async (_label, behavior) => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels, behavior)
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    expect(await supervisor.scanOnce()).toMatchObject({
      outcome: "blocked_unknown_effect",
      reason: "APP_SERVER_THREAD_START_EFFECT_UNKNOWN"
    });
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(channels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(0);
    await runner.close();
  });

  test("preserves unknown provider effect when blocking-status persistence fails", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const originalWriteStatus = DelegationRunStore.prototype.writeStatus;
    const writeStatus = vi.spyOn(DelegationRunStore.prototype, "writeStatus");
    writeStatus.mockImplementationOnce(function (
      this: DelegationRunStore,
      input: Parameters<DelegationRunStore["writeStatus"]>[0]
    ) {
      return originalWriteStatus.call(this, input);
    });
    writeStatus.mockRejectedValueOnce(new Error("fixture status write failure"));
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels, "disconnect-thread-start")
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    expect(await supervisor.scanOnce()).toMatchObject({
      outcome: "blocked_unknown_effect",
      reason: "APP_SERVER_INITIAL_LAUNCH_BOUNDARY_UNKNOWN"
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "unknown",
      provider_contact: "unknown",
      replay_allowed: false,
      outcome_code: "APP_SERVER_INITIAL_LAUNCH_BOUNDARY_UNKNOWN"
    });
    writeStatus.mockRestore();
    await runner.close();
  });

  test("fails closed when thread start acknowledgement is lost", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels, "disconnect-thread-start")
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    expect(await supervisor.scanOnce()).toMatchObject({
      outcome: "blocked_unknown_effect",
      reason: "APP_SERVER_THREAD_START_EFFECT_UNKNOWN"
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "unknown",
      provider_contact: "unknown",
      replay_allowed: false,
      outcome_code: "APP_SERVER_THREAD_START_EFFECT_UNKNOWN"
    });
    expect(await new DelegationRunStore(fixture.taskRoot).readStatus(RUN_ID)).toMatchObject({
      status: "blocked_policy",
      warnings: expect.arrayContaining(["UNKNOWN_EFFECT_NO_REPLAY"])
    });
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    expect(channels[0]!.sent.filter(({ method }) => method === "turn/start")).toHaveLength(0);
    expect(await supervisor.scanOnce()).toMatchObject({ outcome: "idle" });
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(1);
    await runner.close();
  });

  test("records a known failure when both connection attempts precede thread start", async () => {
    const fixture = await runnerFixture();
    const channels: FakeAppServerChannel[] = [];
    const runner = new CodexAppServerInitialRunner(fixture.registry, fixture.bundle.tasks, {
      connection_factory: connectionFactory(fixture, channels, "open-failed")
    });
    const supervisor = fixture.bundle.executionRuntime.createQueueSupervisor({
      repo_id: fixture.repoId,
      runner: "codex_app_server",
      service_identity: serviceIdentity(),
      launcher: runner,
      mode: "external_worker"
    });

    expect(await supervisor.scanOnce()).toMatchObject({
      outcome: "launched",
      result: {
        effect_state: "known_failed",
        provider_contact: "none",
        replay_allowed: false,
        outcome_code: "APP_SERVER_THREAD_START_NOT_SENT"
      }
    });
    expect(await new DelegationDispatchStore(fixture.taskRoot).readResult(RUN_ID)).toMatchObject({
      effect_state: "known_failed",
      provider_contact: "none",
      replay_allowed: false,
      outcome_code: "APP_SERVER_THREAD_START_NOT_SENT"
    });
    expect(await new DelegationRunStore(fixture.taskRoot).readStatus(RUN_ID)).toMatchObject({
      status: "failed",
      warnings: ["APP_SERVER_THREAD_START_NOT_SENT"]
    });
    expect(channels).toHaveLength(1);
    expect(channels[0]!.openAttempts).toBe(2);
    expect(channels[0]!.sent.filter(({ method }) => method === "thread/start")).toHaveLength(0);
    await runner.close();
  });
});

async function runnerFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "initial-runner-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const runtimeRoot = join(parent, "runtime");
  const worktreeRoot = join(parent, "worktrees");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Initial Runner Test");
  await git(ownerRoot, "config", "user.email", "initial-runner@example.invalid");
  await writeFile(join(ownerRoot, "README.md"), "# Initial runner fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const commit = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner fixture",
      root: ownerRoot,
      writes: { enabled: true, allowed_globs: ["**"] },
      operations: { enabled: true },
      lifecycle: {
        kind: "local",
        authority: "ship",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        require_clean_base: true,
        max_concurrent_tasks: 2
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const opened = await bundle.lifecycle.taskOpen({
    operation_id: "open-initial-runner-fixture",
    repo_id: "owner",
    task_id: "task-initial-runner-fixture",
    base_branch: "main",
    base_commit_sha: commit,
    base_tree_sha: tree,
    authority: "implement",
    goal: "Exercise the owner-local initial App Server runner.",
    branch_slug: "initial-runner-fixture"
  });
  const repoId = opened.task.repo_id;
  const taskRoot = registry.get(repoId).root;
  await writeQueuedV3Run(taskRoot, RUN_ID, {
    repo_id: repoId,
    runner: "codex_app_server",
    baseline: { head_sha: commit, worktree_fingerprint: "clean", initial_changed_paths: [] }
  });
  return { registry, bundle, repoId, taskRoot };
}

function connectionFactory(
  fixture: Awaited<ReturnType<typeof runnerFixture>>,
  channels: FakeAppServerChannel[],
  behavior: FakeAppServerBehavior = "normal"
) {
  return (): InitialRunnerConnection => {
    const channel = new FakeAppServerChannel(fixture.taskRoot, behavior);
    channels.push(channel);
    const sink = new CodexAppServerRunSink(fixture.registry, fixture.bundle.tasks);
    const rpc = new CodexAppServerControlRpc(sink, { channel_factory: () => channel });
    return { adapter: new CodexAppServerAdapter(rpc), close: () => rpc.close() };
  };
}

function serviceIdentity() {
  return {
    schema_version: 1 as const,
    service_id: "owner-local-codex-app-server-runner",
    instance_id: "owner-local",
    implementation: "chat-pro-repository-mcp" as const,
    protocol: "semantic-worker-dispatch-v1" as const
  };
}

type JsonMessage = Record<string, unknown> & { method?: string; id?: string | number; params?: Record<string, unknown> };

type FakeAppServerBehavior =
  | "normal"
  | "active"
  | "disconnect-thread-start"
  | "missing-network-access"
  | "network-enabled"
  | "read-only-sandbox"
  | "on-request-approval"
  | "missing-active-profile"
  | "wrong-active-profile"
  | "settled"
  | "open-failed";

class FakeAppServerChannel implements CodexAppServerMessageChannel {
  readonly sent: JsonMessage[] = [];
  closed = false;
  openAttempts = 0;
  private handlers?: { message(value: string): void; close(): void; error(): void };

  constructor(
    private readonly taskRoot: string,
    private readonly behavior: FakeAppServerBehavior
  ) {}

  async open(handlers: { message(value: string): void; close(): void; error(): void }): Promise<void> {
    this.openAttempts += 1;
    if (this.behavior === "open-failed") throw new Error("fixture connection failure");
    this.handlers = handlers;
  }

  async send(value: string): Promise<void> {
    const message = JSON.parse(value) as JsonMessage;
    this.sent.push(message);
    if (message.method === "initialize") {
      this.respond(message.id, { userAgent: "fixture" });
      return;
    }
    if (message.method === "thread/start") {
      if (this.behavior === "disconnect-thread-start") {
        queueMicrotask(() => this.handlers?.close());
        return;
      }
      const response = threadStartResponse(this.taskRoot);
      if (this.behavior === "missing-network-access") {
        this.respond(message.id, { ...response, sandbox: { type: "workspaceWrite" } });
        return;
      }
      if (this.behavior === "network-enabled") {
        this.respond(message.id, { ...response, sandbox: { type: "workspaceWrite", networkAccess: true } });
        return;
      }
      if (this.behavior === "read-only-sandbox") {
        this.respond(message.id, { ...response, sandbox: { type: "readOnly", networkAccess: false } });
        return;
      }
      if (this.behavior === "on-request-approval") {
        this.respond(message.id, { ...response, approvalPolicy: "on-request" });
        return;
      }
      if (this.behavior === "missing-active-profile") {
        this.respond(message.id, { ...response, activePermissionProfile: undefined });
        return;
      }
      if (this.behavior === "wrong-active-profile") {
        this.respond(message.id, { ...response, activePermissionProfile: { id: ":read-only" } });
        return;
      }
      this.respond(message.id, response);
      return;
    }
    if (message.method === "turn/start") {
      this.respond(message.id, { turn: { id: "private-initial-turn", status: "inProgress" } });
      return;
    }
    if (message.method === "thread/read") {
      const settled = this.behavior === "settled";
      this.respond(message.id, {
        thread: {
          id: "private-initial-thread",
          modelProvider: "openai",
          cwd: this.taskRoot,
          status: { type: settled ? "idle" : "active" },
          turns: [{ id: "private-initial-turn", status: settled ? "completed" : "inProgress" }]
        }
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  respond(id: JsonMessage["id"], result: unknown): void {
    if (id === undefined) return;
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ id, result })));
  }

  notify(method: string, params: Record<string, unknown>): void {
    queueMicrotask(() => this.handlers?.message(JSON.stringify({ method, params })));
  }
}

function threadStartResponse(taskRoot: string) {
  return {
    thread: {
      id: "private-initial-thread",
      modelProvider: "openai",
      cwd: taskRoot,
      status: { type: "idle" }
    },
    model: "fixture-model",
    modelProvider: "openai",
    cwd: taskRoot,
    activePermissionProfile: { id: ":workspace", extends: null },
    approvalPolicy: "never",
    sandbox: { type: "workspaceWrite", networkAccess: false }
  };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
