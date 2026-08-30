import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { DelegationSupervisorStore } from "../src/delegation/supervisor-store.js";
import { writeQueuedV3Run } from "./fixtures/delegation-v3-run-fixture.js";
import type { OperationsPolicyConfigDocument } from "../src/config/schema.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository lifecycle runtime", () => {
  test("opens, rehydrates, closes, reads artifacts, and safely cleans an exact task", async () => {
    const fixture = await fixtureRegistry();
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const opened = await bundle.lifecycle.taskOpen({
      operation_id: "operation-open-lifecycle",
      repo_id: "owner",
      task_id: "task-lifecycle",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "ship",
      goal: "Exercise the complete local lifecycle boundary.",
      branch_slug: "lifecycle"
    });
    expect(opened.created).toBe(true);
    expect(opened.task).toMatchObject({
      repo_id: expect.stringMatching(/^task-[a-f0-9]{40}$/),
      base_repo_id: "owner",
      task_id: "task-lifecycle",
      state: "open",
      head_sha: fixture.commit,
      tree_sha: fixture.tree
    });
    expect(fixture.registry.taskBinding(opened.task.repo_id)).toMatchObject({
      task_id: "task-lifecycle",
      base_repo_id: "owner",
      authority: "ship"
    });

    const replayed = await bundle.lifecycle.taskOpen({
      operation_id: "operation-open-lifecycle",
      repo_id: "owner",
      task_id: "task-lifecycle",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "ship",
      goal: "Exercise the complete local lifecycle boundary.",
      branch_slug: "lifecycle"
    });
    expect(replayed).toMatchObject({ created: false, artifact: opened.artifact, task: { repo_id: opened.task.repo_id } });

    const status = await bundle.lifecycle.taskStatus({ repo_id: opened.task.repo_id, task_id: "task-lifecycle" });
    expect(status.task.state).toBe("open");
    expect(status.artifacts).toEqual([opened.artifact]);
    expect(status.last_operation_id).toBe("operation-open-lifecycle");
    const artifact = await bundle.lifecycle.artifactRead({
      repo_id: opened.task.repo_id,
      artifact_id: opened.artifact.artifact_id,
      offset: 0,
      length: 65_536
    });
    expect(artifact.eof).toBe(true);
    expect(JSON.parse(Buffer.from(artifact.data_base64, "base64").toString("utf8"))).toMatchObject({
      semantic: "repo_task_open",
      goal_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const closed = await bundle.lifecycle.taskClose({
      operation_id: "operation-close-lifecycle",
      repo_id: opened.task.repo_id,
      task_id: "task-lifecycle",
      expected_head_sha: fixture.commit,
      expected_tree_sha: fixture.tree,
      outcome: "completed",
      summary: "Local lifecycle fixture completed."
    });
    expect(closed).toMatchObject({ changed: true, outcome: "completed", task: { state: "closed" } });
    expect(fixture.registry.taskBinding(opened.task.repo_id)).toBeUndefined();

    const cleaned = await bundle.lifecycle.taskCleanup({
      operation_id: "operation-cleanup-lifecycle",
      repo_id: opened.task.repo_id,
      task_id: "task-lifecycle",
      expected_head_sha: fixture.commit,
      expected_tree_sha: fixture.tree,
      cleanup_scope: "workspace_and_artifacts"
    });
    expect(cleaned).toMatchObject({ state: "cleaned", workspace_removed: true, artifacts_removed: 1, changed: true });
    expect((await bundle.artifacts.listMetadata("task-lifecycle")).map((entry) => entry.kind))
      .toEqual(["operation_receipt", "operation_receipt"]);
    expect(await bundle.lifecycle.taskCleanup({
      operation_id: "operation-cleanup-lifecycle",
      repo_id: opened.task.repo_id,
      task_id: "task-lifecycle",
      expected_head_sha: fixture.commit,
      expected_tree_sha: fixture.tree,
      cleanup_scope: "workspace_and_artifacts"
    })).toEqual(cleaned);
  }, 15_000);

  test("opens a local-only task, preserves local ship authority, and rejects every external lifecycle call", async () => {
    const fixture = await fixtureRegistry({ kind: "local" });
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const opened = await bundle.lifecycle.taskOpen({
      operation_id: "operation-open-local-only",
      repo_id: "owner",
      task_id: "task-local-only",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "ship",
      goal: "Exercise a local-only task without remote or GitHub effects.",
      branch_slug: "local-only"
    });
    expect(fixture.registry.get(opened.task.repo_id)).toMatchObject({
      writes: { enabled: true },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: true
      }
    });

    const exact = {
      operation_id: "operation-local-external-denied",
      repo_id: opened.task.repo_id,
      task_id: "task-local-only",
      expected_head_sha: fixture.commit,
      expected_tree_sha: fixture.tree
    };
    const externalCalls: Array<() => Promise<unknown>> = [
      () => bundle.lifecycle.remoteStatus(exact),
      () => bundle.lifecycle.writePush(exact),
      () => bundle.lifecycle.prCreateOrUpdate({ ...exact, title: "Denied", body: "Denied", draft: true }),
      () => bundle.lifecycle.prStatus(exact),
      () => bundle.lifecycle.prReviewThreads(exact),
      () => bundle.lifecycle.writePrReply({ ...exact, thread_id: "thread-1", body: "Denied" }),
      () => bundle.lifecycle.writePrResolveThread({
        ...exact,
        thread_id: "thread-1",
        expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
      }),
      () => bundle.lifecycle.ciStatus(exact),
      () => bundle.lifecycle.writeCiRetryFailed({
        ...exact,
        ci_status_id: "ci_status_1234567890abcdef",
        failed_run_ids: ["123"]
      }),
      () => bundle.lifecycle.mergeGatePrepare(exact),
      () => bundle.lifecycle.writeMerge({
        ...exact,
        manifest_id: "merge_manifest_1234567890abcdef",
        manifest_sha256: "a".repeat(64),
        approval_id: "merge_approval_1234567890abcdef"
      }),
      () => bundle.lifecycle.postMergeReadback({ ...exact, merge_operation_id: "operation-local-merge-denied" })
    ];
    for (const call of externalCalls) {
      await expect(call()).rejects.toMatchObject({ code: "LIFECYCLE_POLICY_DENIED" });
    }

    await bundle.lifecycle.taskClose({
      ...exact,
      operation_id: "operation-close-local-only",
      outcome: "completed",
      summary: "Local-only lifecycle completed without external effects."
    });
    const cleaned = await bundle.lifecycle.taskCleanup({
      ...exact,
      operation_id: "operation-cleanup-local-only",
      cleanup_scope: "workspace_only"
    });
    expect(cleaned).toMatchObject({ state: "cleaned", workspace_removed: true });
  }, 15_000);

  test("applies local task-only operations without broadening the base and clamps lower authority", async () => {
    const baseOperations: OperationsPolicyConfigDocument = {
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      codex_run_finalize_enabled: true,
      validation_enabled: false,
      cleanup_enabled: false,
      max_paths_per_operation: 50
    };
    const taskOperations: OperationsPolicyConfigDocument = {
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      codex_run_finalize_enabled: false,
      validation_enabled: true,
      cleanup_enabled: false,
      max_paths_per_operation: 7
    };
    const fixture = await fixtureRegistry({
      kind: "local",
      maxConcurrentTasks: 3,
      baseOperations,
      taskOperations
    });
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const baseBefore = structuredClone(fixture.registry.getBase("owner").operations);
    const open = async (authority: "inspect" | "implement" | "ship", suffix: string) => bundle.lifecycle.taskOpen({
      operation_id: `operation-open-task-ops-${suffix}`,
      repo_id: "owner",
      task_id: `task-ops-${suffix}`,
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority,
      goal: `Exercise task-only operations for ${authority}.`,
      branch_slug: `task-ops-${suffix}`
    });

    const ship = await open("ship", "ship");
    expect(fixture.registry.get(ship.task.repo_id).operations).toMatchObject({
      enabled: true,
      validation_enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      codex_run_finalize_enabled: false,
      cleanup_enabled: false,
      max_paths_per_operation: 7
    });

    const implement = await open("implement", "implement");
    expect(fixture.registry.get(implement.task.repo_id).operations).toMatchObject({
      enabled: true,
      validation_enabled: true,
      git_stage_enabled: false,
      git_commit_enabled: false,
      codex_run_finalize_enabled: false,
      cleanup_enabled: false,
      max_paths_per_operation: 7
    });

    const inspect = await open("inspect", "inspect");
    expect(fixture.registry.get(inspect.task.repo_id).operations).toMatchObject({
      enabled: false,
      validation_enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      codex_run_finalize_enabled: false,
      cleanup_enabled: false,
      max_paths_per_operation: 7
    });
    expect(fixture.registry.getBase("owner").operations).toEqual(baseBefore);
  }, 15_000);

  test("enforces repository authority, allowed base branch, clean base, and task capacity", async () => {
    const fixture = await fixtureRegistry({ authority: "write", maxConcurrentTasks: 1 });
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const request = {
      operation_id: "operation-policy-open",
      repo_id: "owner",
      task_id: "task-policy",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "implement" as const,
      goal: "Exercise policy admission.",
      branch_slug: "policy"
    };
    await expect(bundle.lifecycle.taskOpen({ ...request, authority: "ship" }))
      .rejects.toMatchObject({ code: "LIFECYCLE_POLICY_DENIED" });
    await expect(bundle.lifecycle.taskOpen({ ...request, base_branch: "release" }))
      .rejects.toMatchObject({ code: "LIFECYCLE_POLICY_DENIED" });
    await writeFile(join(fixture.ownerRoot, "dirty.txt"), "dirty\n");
    await expect(bundle.lifecycle.taskOpen(request)).rejects.toMatchObject({ code: "GIT_WORKTREE_DIRTY" });
    await rm(join(fixture.ownerRoot, "dirty.txt"));
    const opened = await bundle.lifecycle.taskOpen(request);
    expect(fixture.registry.get(opened.task.repo_id).operations).toMatchObject({
      enabled: true,
      validation_enabled: true,
      git_stage_enabled: false,
      git_commit_enabled: false,
      codex_run_finalize_enabled: false
    });
    await expect(bundle.lifecycle.taskOpen({
      ...request,
      operation_id: "operation-policy-second",
      task_id: "task-policy-second",
      branch_slug: "policy-second"
    })).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
  });

  test("keeps task status available after the public artifact window is full", async () => {
    const fixture = await fixtureRegistry();
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const opened = await bundle.lifecycle.taskOpen({
      operation_id: "operation-open-artifact-window",
      repo_id: "owner",
      task_id: "task-artifact-window",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "inspect",
      goal: "Exercise bounded task-status artifact discovery.",
      branch_slug: "artifact-window"
    });
    for (let index = 0; index < 200; index += 1) {
      await bundle.artifacts.put({
        task_id: "task-artifact-window",
        kind: "review_evidence",
        media_type: "text/plain",
        logical_path: `evidence/status-${index}.txt`,
        content: `status evidence ${index}`
      });
    }

    const status = await bundle.lifecycle.taskStatus({
      repo_id: opened.task.repo_id,
      task_id: "task-artifact-window"
    });
    expect(status.artifacts).toHaveLength(200);
    expect(status.warnings).toContain("ARTIFACTS_TRUNCATED");
  }, 30_000);
  test("qualifies provider-free queue supervision through the existing lifecycle bundle", async () => {
    const fixture = await fixtureRegistry({ kind: "local" });
    const bundle = await createLifecycleRuntimeBundle(fixture.registry);
    const opened = await bundle.lifecycle.taskOpen({
      operation_id: "operation-open-execution-runtime",
      repo_id: "owner",
      task_id: "task-execution-runtime",
      base_branch: "main",
      base_commit_sha: fixture.commit,
      base_tree_sha: fixture.tree,
      authority: "implement",
      goal: "Qualify one bounded provider-free admitted dispatch.",
      branch_slug: "execution-runtime"
    });
    const taskRoot = fixture.registry.get(opened.task.repo_id).root;
    const runId = "2026-08-26T020000Z-provider-free-integration";
    await writeQueuedV3Run(taskRoot, runId, {
      repo_id: opened.task.repo_id,
      baseline: {
        head_sha: opened.task.head_sha,
        worktree_fingerprint: "clean",
        initial_changed_paths: []
      }
    });

    let launches = 0;
    const supervisor = bundle.executionRuntime.createQueueSupervisor({
      repo_id: opened.task.repo_id,
      runner: "codex_sdk",
      service_identity: {
        schema_version: 1,
        service_id: "global-development-supervisor",
        instance_id: "provider-free-qualification",
        implementation: "chat-pro-repository-mcp",
        protocol: "semantic-worker-dispatch-v1"
      },
      mode: "provider_free",
      launcher: {
        async launch() {
          launches += 1;
          return {
            effect_state: "no_external_effect",
            provider_contact: "none",
            terminal_state: "completed",
            outcome_code: "PROVIDER_FREE_QUALIFIED"
          };
        }
      }
    });

    const first = await supervisor.scanOnce();
    const second = await supervisor.scanOnce();
    expect(first).toMatchObject({ outcome: "launched", run_id: runId });
    expect(second).toMatchObject({ outcome: "already_settled", run_id: runId });
    expect(launches).toBe(1);

    const state = await new DelegationSupervisorStore(taskRoot).read();
    expect(state).toMatchObject({
      repo_id: opened.task.repo_id,
      status: "ready",
      active_run_id: null,
      service_identity: {
        service_id: "global-development-supervisor",
        instance_id: "provider-free-qualification"
      },
      health_attestation: {
        queue_consumer: "idle",
        unknown_effect_count: 0,
        provider_contact: "none",
        live_effects_enabled: false
      }
    });
  });

});

async function fixtureRegistry(options: {
  authority?: "read" | "write" | "ship";
  kind?: "github" | "local";
  maxConcurrentTasks?: number;
  baseOperations?: OperationsPolicyConfigDocument;
  taskOperations?: OperationsPolicyConfigDocument;
} = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "repository-lifecycle-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const runtimeRoot = join(parent, "runtime");
  const worktreeRoot = join(parent, "worktrees");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Lifecycle Test");
  await git(ownerRoot, "config", "user.email", "lifecycle@example.com");
  await writeFile(join(ownerRoot, "README.md"), "# Lifecycle fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const commit = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const lifecycle = options.kind === "local"
    ? {
        kind: "local" as const,
        authority: options.authority ?? "ship",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        require_clean_base: true,
        max_concurrent_tasks: options.maxConcurrentTasks ?? 8,
        ...(options.taskOperations ? { task_operations: options.taskOperations } : {})
      }
    : {
        kind: "github" as const,
        authority: options.authority ?? "ship",
        remote_name: "origin",
        expected_remote_identity: "https://github.com/example/fixture.git",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        github_repository: "example/fixture",
        merge_method: "squash" as const,
        required_checks: ["test"],
        require_clean_base: true,
        max_concurrent_tasks: options.maxConcurrentTasks ?? 8
      };
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner fixture",
      root: ownerRoot,
      writes: { enabled: true, allowed_globs: ["**"] },
      operations: options.baseOperations ?? {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: true,
        cleanup_enabled: true
      },
      lifecycle
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  return { parent, ownerRoot, runtimeRoot, worktreeRoot, commit, tree, registry };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
