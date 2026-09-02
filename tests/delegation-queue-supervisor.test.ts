import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
  type ExecutionSupervisorServiceIdentity
} from "../src/delegation/artifact-contracts.js";
import { DelegationDispatchStore } from "../src/delegation/dispatch-store.js";
import { DelegationQueueSupervisor } from "../src/delegation/queue-supervisor.js";
import { DelegationRunStore } from "../src/delegation/run-store.js";
import {
  AGENT_RUNNER_SUPERVISOR_STATE_PATH,
  DelegationSupervisorStore
} from "../src/delegation/supervisor-store.js";
import type { RootRegistry } from "../src/services/root-registry.js";
import { TaskAdmissionService } from "../src/services/task-admission-service.js";
import { canonicalSha256, type TaskRuntimeService, type TaskState } from "../src/task-runtime/index.js";
import { writeQueuedV3Run } from "./fixtures/delegation-v3-run-fixture.js";

const RUN_ID = "2026-08-26T020000Z-provider-free-qualification";
const BASE_REPO_ID = "fixture-base";
const TASK_ID = "aidcp-runtime-task";
const TREE = "b".repeat(40);
const NOW = "2026-08-26T02:00:00.000Z";
const IDENTITY: ExecutionSupervisorServiceIdentity = {
  schema_version: 1,
  service_id: "global-development.execution-supervisor",
  instance_id: "provider-free-qualification",
  implementation: "chat-pro-repository-mcp",
  protocol: "semantic-worker-dispatch-v1"
};

function taskState(head: string): TaskState {
  return {
    schema_version: 1,
    task_id: TASK_ID,
    repo_id: "fixture",
    base_repo_id: BASE_REPO_ID,
    base_branch: "main",
    base_commit: "c".repeat(40),
    base_tree: "d".repeat(40),
    authority: "implement",
    goal: "Resolve the bounded AIDCP external execution-runtime dependency.",
    branch_slug: "aidcp-runtime",
    server_branch: `chat-pro/tasks/aidcp-runtime-${"e".repeat(12)}`,
    worktree_path: "/tmp/chat-pro-provider-free-task",
    lifecycle: "OPEN",
    worktree_state: "PRESENT",
    branch_state: "PRESENT",
    worktree_head: head,
    worktree_tree: TREE,
    registration_state: "REGISTERED",
    close_disposition: null,
    closed_at: null,
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    state_sha256: "f".repeat(64)
  };
}

function admissionService(task: TaskState, unrelatedTasks: TaskState[] = []): TaskAdmissionService {
  const registry = {
    getBase(repoId: string) {
      if (repoId !== BASE_REPO_ID) throw new Error("unexpected base repo");
      return { repo_id: repoId, lifecycle: {} };
    },
    taskBinding(repoId: string) {
      if (repoId !== task.repo_id) return undefined;
      return {
        task_id: task.task_id,
        task_repo_id: task.repo_id,
        base_repo_id: task.base_repo_id,
        authority: task.authority,
        branch: task.server_branch,
        worktree: task.worktree_path
      };
    }
  } as unknown as RootRegistry;
  const runtime = {
    async listTasks() {
      return [task, ...unrelatedTasks];
    },
    async status(taskId: string) {
      if (taskId !== task.task_id) throw new Error("unexpected task");
      return {
        repo_id: task.repo_id,
        task,
        observed_worktree: {
          disposition: "EXACT" as const,
          path_present: true,
          registered: true,
          branch_present: true,
          observed_head: task.worktree_head,
          observed_tree: task.worktree_tree,
          observed_branch: task.server_branch
        },
        git_status: {
          clean: true,
          porcelain_z: "",
          changed_entry_count: 0,
          head: task.worktree_head!,
          tree: task.worktree_tree!,
          branch: task.server_branch
        }
      };
    }
  } as unknown as TaskRuntimeService;
  return new TaskAdmissionService(registry, runtime);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-pro-queue-supervisor-"));
  const manifest = await writeQueuedV3Run(root, RUN_ID);
  const task = taskState(manifest.baseline.head_sha);
  return { root, manifest, task, admission: admissionService(task) };
}

function supervisor(input: {
  root: string;
  admission: TaskAdmissionService;
  launch: () => Promise<{
    effect_state: "no_external_effect" | "known_complete" | "known_failed" | "unknown";
    provider_contact: "none" | "confirmed" | "unknown";
    terminal_state: "completed" | "blocked" | "failed" | "unknown";
    outcome_code: string;
  }>;
}) {
  return new DelegationQueueSupervisor({
    root: input.root,
    repo_id: "fixture",
    runner: "codex_sdk",
    service_identity: IDENTITY,
    admission: input.admission,
    launcher: { launch: input.launch },
    mode: "provider_free",
    now: () => new Date(NOW)
  });
}

describe("DelegationQueueSupervisor", () => {
  test("qualifies one admitted dispatch with exactly one provider-free launch", async () => {
    const { root, admission } = await fixture();
    try {
      let launches = 0;
      const queue = supervisor({
        root,
        admission,
        launch: async () => {
          launches += 1;
          return {
            effect_state: "no_external_effect",
            provider_contact: "none",
            terminal_state: "completed",
            outcome_code: "PROVIDER_FREE_QUALIFICATION_PASS"
          };
        }
      });
      const [first, concurrent] = await Promise.all([queue.scanOnce(), queue.scanOnce()]);
      expect(first).toEqual(concurrent);
      expect(first).toMatchObject({ outcome: "launched", run_id: RUN_ID });
      expect(launches).toBe(1);

      const replay = await queue.scanOnce();
      expect(replay).toMatchObject({ outcome: "already_settled", run_id: RUN_ID });
      expect(launches).toBe(1);

      const dispatches = new DelegationDispatchStore(root, () => new Date(NOW));
      const dispatch = await dispatches.readDispatch(RUN_ID);
      const intent = await dispatches.readIntent(RUN_ID);
      const result = await dispatches.readResult(RUN_ID);
      expect(dispatch).toMatchObject({
        repo_id: "fixture",
        run_id: RUN_ID,
        launch_ordinal: 1,
        replay_policy: "never_after_launch_intent",
        max_runtime_ms: DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
      });
      expect(intent).toMatchObject({ dispatch_id: dispatch?.dispatch_id, launch_ordinal: 1 });
      expect(result).toMatchObject({
        dispatch_id: dispatch?.dispatch_id,
        effect_state: "no_external_effect",
        provider_contact: "none",
        terminal_state: "completed",
        replay_allowed: false
      });

      const state = await new DelegationSupervisorStore(root).read();
      expect(state).toMatchObject({
        repo_id: "fixture",
        runner: "codex_sdk",
        status: "ready",
        service_identity: IDENTITY,
        health_attestation: {
          status: "ready",
          queue_consumer: "idle",
          unknown_effect_count: 0,
          provider_contact: "none",
          live_effects_enabled: false
        }
      });
      expect(state?.health_attestation?.attestation_sha256).toMatch(/^[a-f0-9]{64}$/);

      await expect(dispatches.ensureLaunchIntent(dispatch!, {
        ...IDENTITY,
        instance_id: "different-supervisor"
      })).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });

      await expect(dispatches.ensureAdmitted({
        repo_id: dispatch!.repo_id,
        run_id: dispatch!.run_id,
        runner: dispatch!.runner,
        task_binding: { ...dispatch!.task_binding, tree_sha: "1".repeat(40) },
        delegation_binding: dispatch!.delegation_binding,
        supervisor: dispatch!.supervisor,
        max_runtime_ms: dispatch!.max_runtime_ms
      })).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("launches an exact queued task while an unrelated task shares its base repository", async () => {
    const { root, task } = await fixture();
    try {
      const unrelated = {
        ...task,
        task_id: "unrelated-task",
        repo_id: "unrelated-fixture",
        branch_slug: "unrelated-task",
        server_branch: `chat-pro/tasks/unrelated-task-${"a".repeat(12)}`,
        worktree_path: "/tmp/chat-pro-unrelated-task",
        worktree_head: "8".repeat(40),
        worktree_tree: "9".repeat(40),
        state_sha256: "a".repeat(64)
      };
      const admission = admissionService(task, [unrelated]);
      let launches = 0;
      const result = await supervisor({
        root,
        admission,
        launch: async () => {
          launches += 1;
          return {
            effect_state: "no_external_effect",
            provider_contact: "none",
            terminal_state: "completed",
            outcome_code: "UNRELATED_TASK_COEXISTENCE_PASS"
          };
        }
      }).scanOnce();

      expect(result).toMatchObject({ outcome: "launched", run_id: RUN_ID });
      expect(launches).toBe(1);
      expect(await new DelegationDispatchStore(root).readDispatch(RUN_ID)).toMatchObject({
        task_binding: {
          task_id: TASK_ID,
          task_repo_id: "fixture",
          base_repo_id: BASE_REPO_ID
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a matching immutable launch intent before accepting a result", async () => {
    const { root, admission } = await fixture();
    try {
      const run = await new DelegationRunStore(root).readRun(RUN_ID);
      const admitted = await admission.readForDelegationRun(run);
      expect(admitted.admission).toBe("matching_active_task");
      if (admitted.admission !== "matching_active_task" || run.manifest.schema_version !== 3) return;
      const store = new DelegationDispatchStore(root, () => new Date(NOW));
      const { dispatch } = await store.ensureAdmitted({
        repo_id: run.repo_id,
        run_id: run.run_id,
        runner: "codex_sdk",
        task_binding: {
          task_id: admitted.task.task_id,
          task_repo_id: admitted.task.task_repo_id,
          base_repo_id: admitted.task.base_repo_id,
          head_sha: admitted.task.head_sha,
          tree_sha: admitted.task.tree_sha,
          state_sha256: admitted.task.state_sha256,
          binding_sha256: admitted.task.binding_sha256
        },
        delegation_binding: {
          manifest_canonical_sha256: canonicalSha256(run.manifest),
          task_sha256: run.manifest.task_sha256,
          baseline_sha256: run.manifest.baseline_sha256,
          prompt_sha256: run.manifest.prompt_sha256
        },
        supervisor: IDENTITY,
        max_runtime_ms: DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
      });

      await expect(store.writeLaunchResult({
        dispatch,
        outcome: {
          effect_state: "no_external_effect",
          provider_contact: "none",
          terminal_state: "completed",
          outcome_code: "MUST_NOT_PERSIST"
        },
        started_at: NOW
      })).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
      expect(await store.readResult(RUN_ID)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves invalid supervisor evidence instead of overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-pro-supervisor-invalid-"));
    try {
      await mkdir(join(root, ".chatgpt", "codex-runs"), { recursive: true });
      const statePath = join(root, AGENT_RUNNER_SUPERVISOR_STATE_PATH);
      const invalid = "{\"schema_version\":1}\n";
      await writeFile(statePath, invalid, { encoding: "utf8", mode: 0o600 });
      const store = new DelegationSupervisorStore(root);
      await expect(store.write({
        repo_id: "fixture",
        runner: "codex_sdk",
        status: "ready",
        heartbeat_at: NOW,
        last_scan_at: NOW,
        last_claimed_run_id: null,
        active_run_id: null,
        stale_after_ms: 30_000,
        warnings: []
      })).rejects.toMatchObject({ code: "AGENT_RUN_ARTIFACT_INVALID" });
      expect(await readFile(statePath, "utf8")).toBe(invalid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records a launcher exception as unknown and never launches that dispatch again", async () => {
    const { root, admission } = await fixture();
    try {
      let launches = 0;
      const queue = supervisor({
        root,
        admission,
        launch: async () => {
          launches += 1;
          throw new Error("simulated uncertain launch boundary");
        }
      });
      expect(await queue.scanOnce()).toMatchObject({
        outcome: "blocked_unknown_effect",
        reason: "LAUNCH_BOUNDARY_UNKNOWN"
      });
      expect(await queue.scanOnce()).toMatchObject({
        outcome: "blocked_unknown_effect",
        reason: "PERSISTED_UNKNOWN_EFFECT"
      });
      expect(launches).toBe(1);
      expect(await new DelegationDispatchStore(root).readResult(RUN_ID)).toMatchObject({
        effect_state: "unknown",
        provider_contact: "unknown",
        terminal_state: "unknown",
        replay_allowed: false
      });
      expect(await new DelegationSupervisorStore(root).read()).toMatchObject({
        status: "degraded",
        health_attestation: {
          queue_consumer: "blocked_unknown_effect",
          unknown_effect_count: 1,
          provider_contact: "possible"
        },
        warnings: ["UNKNOWN_EFFECT_NO_REPLAY"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("treats an intent without a result as an unknown effect and does not call the launcher", async () => {
    const { root, admission } = await fixture();
    try {
      const run = await new DelegationRunStore(root).readRun(RUN_ID);
      const admitted = await admission.readForDelegationRun(run);
      expect(admitted.admission).toBe("matching_active_task");
      if (admitted.admission !== "matching_active_task" || run.manifest.schema_version !== 3) return;
      const store = new DelegationDispatchStore(root, () => new Date(NOW));
      const { dispatch } = await store.ensureAdmitted({
        repo_id: run.repo_id,
        run_id: run.run_id,
        runner: "codex_sdk",
        task_binding: {
          task_id: admitted.task.task_id,
          task_repo_id: admitted.task.task_repo_id,
          base_repo_id: admitted.task.base_repo_id,
          head_sha: admitted.task.head_sha,
          tree_sha: admitted.task.tree_sha,
          state_sha256: admitted.task.state_sha256,
          binding_sha256: admitted.task.binding_sha256
        },
        delegation_binding: {
          manifest_canonical_sha256: canonicalSha256(run.manifest),
          task_sha256: run.manifest.task_sha256,
          baseline_sha256: run.manifest.baseline_sha256,
          prompt_sha256: run.manifest.prompt_sha256
        },
        supervisor: IDENTITY,
        max_runtime_ms: DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
      });
      await store.ensureLaunchIntent(dispatch, IDENTITY, NOW);

      let launches = 0;
      const queue = supervisor({
        root,
        admission,
        launch: async () => {
          launches += 1;
          return {
            effect_state: "no_external_effect",
            provider_contact: "none",
            terminal_state: "completed",
            outcome_code: "MUST_NOT_RUN"
          };
        }
      });
      expect(await queue.scanOnce()).toMatchObject({
        outcome: "blocked_unknown_effect",
        reason: "LAUNCH_INTENT_WITHOUT_RESULT"
      });
      expect(launches).toBe(0);
      expect(await store.readResult(RUN_ID)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not create dispatch evidence or launch when no active task is admitted", async () => {
    const { root, task } = await fixture();
    try {
      const absentRegistry = {
        getBase() {
          return { repo_id: BASE_REPO_ID, lifecycle: {} };
        },
        taskBinding() {
          return undefined;
        }
      } as unknown as RootRegistry;
      const absentRuntime = {
        async listTasks() {
          return [];
        }
      } as unknown as TaskRuntimeService;
      let launches = 0;
      const queue = supervisor({
        root,
        admission: new TaskAdmissionService(absentRegistry, absentRuntime),
        launch: async () => {
          launches += 1;
          return {
            effect_state: "no_external_effect",
            provider_contact: "none",
            terminal_state: "completed",
            outcome_code: "MUST_NOT_RUN"
          };
        }
      });
      expect(await queue.scanOnce()).toMatchObject({
        outcome: "not_admitted",
        admission: "task_absent",
        reason: "TASK_REPOSITORY_NOT_REGISTERED"
      });
      expect(launches).toBe(0);
      expect(await new DelegationDispatchStore(root).readDispatch(RUN_ID)).toBeUndefined();
      expect(task.task_id).toBe(TASK_ID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
