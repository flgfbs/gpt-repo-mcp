import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RootRegistry } from "../src/services/root-registry.js";

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
    await bundle.lifecycle.taskOpen(request);
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
});

async function fixtureRegistry(options: { authority?: "read" | "write" | "ship"; maxConcurrentTasks?: number } = {}) {
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
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner fixture",
      root: ownerRoot,
      lifecycle: {
        authority: options.authority ?? "ship",
        remote_name: "origin",
        expected_remote_identity: "https://github.com/example/fixture.git",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        github_repository: "example/fixture",
        merge_method: "squash",
        required_checks: ["test"],
        require_clean_base: true,
        max_concurrent_tasks: options.maxConcurrentTasks ?? 8
      }
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
