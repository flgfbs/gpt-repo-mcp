import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { OwnerApprovalStore } from "../src/github/owner-approval-store.js";
import type {
  ExactGitBoundary,
  LocalGitSnapshot,
  MergeApiResult,
  ServerOwnedTask
} from "../src/github/types.js";
import { GitRemoteService } from "../src/services/git-remote-service.js";
import { GitHubCiService } from "../src/services/github-ci-service.js";
import { GitHubLifecycleRuntime } from "../src/services/github-lifecycle-runtime.js";
import { GitHubMergeGateService } from "../src/services/github-merge-gate-service.js";
import { GitHubMergeService } from "../src/services/github-merge-service.js";
import { GitHubPostMergeService } from "../src/services/github-post-merge-service.js";
import { GitHubPrService } from "../src/services/github-pr-service.js";
import { GitHubReviewService } from "../src/services/github-review-service.js";
import {
  DurableGitHubOperationLedger,
  RegistryTaskLookup,
  TaskArtifactGitHubSink,
  TaskArtifactMergeEvidenceProvider
} from "../src/services/github-runtime-adapters.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RepositoryLifecycleRuntime } from "../src/services/repository-lifecycle-runtime.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { attachValidationArtifactCapture } from "../src/services/validation-artifact-capture.js";
import {
  FixedClock,
  FakeGitHubAdapter,
  MERGE_SHA,
  makePullRequest,
  makeReviewThread
} from "./fixtures/github-lifecycle-fixtures.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic full lifecycle fixture", () => {
  test("runs registration through retained-branch cleanup without live GitHub", async () => {
    const fixture = await setupFixture();
    const opened = await fixture.bundle.lifecycle.taskOpen({
      operation_id: "e2e-open-task",
      repo_id: "fixture-owner",
      task_id: "e2e-task",
      base_branch: "main",
      base_commit_sha: fixture.baseHead,
      base_tree_sha: fixture.baseTree,
      authority: "ship",
      goal: "Exercise the deterministic full repository lifecycle.",
      branch_slug: "full-lifecycle"
    });
    const taskRepoId = opened.task.repo_id;
    const worktree = fixture.registry.get(taskRepoId).root;
    const taskLookup = new RegistryTaskLookup(fixture.registry, fixture.bundle.tasks);
    const task = await taskLookup.getServerOwnedTask(taskRepoId);
    const github = configuredFakeGitHub(task, fixture.baseHead, fixture.baseTree);
    const gitBoundary = new LocalBareGitBoundary(fixture.bareRemote, github);
    const ledger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    await ledger.initialize();
    const githubArtifacts = new TaskArtifactGitHubSink(
      taskLookup,
      fixture.bundle.artifacts,
      fixture.bundle.tasks.fs,
      fixture.bundle.tasks.locks
    );
    const clock = new FixedClock();
    const ci = new GitHubCiService(taskLookup, gitBoundary, github, githubArtifacts, ledger, clock);
    const evidence = new TaskArtifactMergeEvidenceProvider(
      fixture.bundle.artifacts,
      gitBoundary,
      github,
      githubArtifacts
    );
    const remote = new GitRemoteService(taskLookup, gitBoundary, github, githubArtifacts, ledger, clock);
    const pullRequests = new GitHubPrService(taskLookup, gitBoundary, github, githubArtifacts, ledger, clock);
    const reviews = new GitHubReviewService(taskLookup, gitBoundary, github, evidence, githubArtifacts, ledger, clock);
    const gates = new GitHubMergeGateService(
      taskLookup,
      gitBoundary,
      github,
      ci,
      evidence,
      githubArtifacts,
      ledger,
      clock
    );
    const approvals = new OwnerApprovalStore(
      { getRuntimeRoot: async () => fixture.runtimeRoot },
      clock,
      { createOpaqueId: () => "ABCDEFGHIJKLMNOPQRSTUVWX" }
    );
    const merge = new GitHubMergeService(
      taskLookup,
      gitBoundary,
      github,
      gates,
      approvals,
      githubArtifacts,
      ledger,
      clock
    );
    const postMerge = new GitHubPostMergeService(
      taskLookup,
      gitBoundary,
      github,
      ci,
      githubArtifacts,
      ledger,
      clock
    );
    const external = new GitHubLifecycleRuntime(taskLookup, githubArtifacts, {
      remote,
      pullRequests,
      reviews,
      ci,
      gates,
      merge,
      postMerge
    });
    const lifecycle = new RepositoryLifecycleRuntime(
      fixture.registry,
      fixture.bundle.tasks,
      fixture.bundle.artifacts,
      external
    );

    await runMutation(fixture, taskRepoId, "e2e-edit-multiple", fixture.baseHead, fixture.baseTree, "repo_write_changes", async () => {
      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(join(worktree, "src", "value.ts"), "export const value = 1;\n");
      await writeFile(join(worktree, "CHANGELOG.md"), "# Changes\n\n- Add deterministic fixture.\n");
    });
    await runValidation(fixture, taskRepoId, "e2e-validation-dirty", fixture.baseHead, fixture.baseTree);
    expect((await git(worktree, "diff", "--name-only")).split("\n").sort()).toEqual(["CHANGELOG.md", "src/value.ts"]);
    await git(worktree, "diff", "--check");

    await runMutation(fixture, taskRepoId, "e2e-stage-initial", fixture.baseHead, fixture.baseTree, "repo_write_stage", async () => {
      await git(worktree, "add", "--", "CHANGELOG.md", "src/value.ts");
    });
    await runMutation(fixture, taskRepoId, "e2e-commit-initial", fixture.baseHead, fixture.baseTree, "repo_write_commit", async () => {
      await git(worktree, "commit", "-m", "Add deterministic fixture changes");
    });
    const firstHead = await git(worktree, "rev-parse", "HEAD");
    const firstTree = await git(worktree, "rev-parse", "HEAD^{tree}");
    await runValidation(fixture, taskRepoId, "e2e-validation-first-head", firstHead, firstTree);
    configureSuccessfulCi(github, firstHead);

    const remoteBefore = await lifecycle.remoteStatus(exactInput("e2e-remote-before", taskRepoId, firstHead, firstTree));
    expect(remoteBefore).toMatchObject({
      relationship: "absent",
      normalized_remote_identity: "github.com/example/project",
      configured_repository_identity: "example/project"
    });
    const pushed = await lifecycle.writePush(exactInput("e2e-push-first", taskRepoId, firstHead, firstTree));
    expect(pushed.contact.effect_state).toBe("pushed");
    expect(await gitBare(fixture.bareRemote, "rev-parse", `refs/heads/${task.branch}`)).toBe(firstHead);

    const createdPr = await lifecycle.prCreateOrUpdate({
      ...exactInput("e2e-pr-create", taskRepoId, firstHead, firstTree),
      title: "Deterministic lifecycle fixture",
      body: "Exercises the fake GitHub lifecycle.",
      draft: true
    });
    expect(createdPr).toMatchObject({ action: "created", pull_request: { draft: true, head_sha: firstHead } });
    const firstCi = await lifecycle.ciStatus(exactInput("e2e-ci-first", taskRepoId, firstHead, firstTree));
    expect(firstCi).toMatchObject({ overall: "success", runs: [{ run_id: "9001", event: "push" }] });

    const thread = makeReviewThread();
    thread.pullRequestId = github.pullRequest.id;
    thread.pullRequestNumber = github.pullRequest.number;
    thread.headSha = firstHead;
    github.reviewThreads = [thread];
    const observedThreads = await lifecycle.prReviewThreads({
      ...exactInput("e2e-thread-observe", taskRepoId, firstHead, firstTree),
      limit: 25
    });
    expect(observedThreads.threads).toHaveLength(1);

    await runMutation(fixture, taskRepoId, "e2e-correction-edit", firstHead, firstTree, "repo_write_file", async () => {
      await writeFile(join(worktree, "src", "value.ts"), "export const value = 2;\n");
    });
    await runMutation(fixture, taskRepoId, "e2e-correction-stage", firstHead, firstTree, "repo_write_stage", async () => {
      await git(worktree, "add", "--", "src/value.ts");
    });
    await runMutation(fixture, taskRepoId, "e2e-correction-commit", firstHead, firstTree, "repo_write_commit", async () => {
      await git(worktree, "commit", "-m", "Address review thread");
    });
    const finalHead = await git(worktree, "rev-parse", "HEAD");
    const finalTree = await git(worktree, "rev-parse", "HEAD^{tree}");
    await runValidation(fixture, taskRepoId, "e2e-validation-final-head", finalHead, finalTree);
    configureSuccessfulCi(github, finalHead);
    await lifecycle.writePush(exactInput("e2e-push-correction", taskRepoId, finalHead, finalTree));
    await lifecycle.prCreateOrUpdate({
      ...exactInput("e2e-pr-update", taskRepoId, finalHead, finalTree),
      title: "Deterministic lifecycle fixture",
      body: "Exercises the corrected fake GitHub lifecycle.",
      draft: true
    });
    const finalCi = await lifecycle.ciStatus(exactInput("e2e-ci-final", taskRepoId, finalHead, finalTree));
    expect(finalCi.overall).toBe("success");
    const replied = await lifecycle.writePrReply({
      ...exactInput("e2e-thread-reply", taskRepoId, finalHead, finalTree),
      thread_id: thread.id,
      body: "Addressed by the corrected exact head and revalidated."
    });
    expect(replied.created).toBe(true);
    const resolved = await lifecycle.writePrResolveThread({
      ...exactInput("e2e-thread-resolve", taskRepoId, finalHead, finalTree),
      thread_id: thread.id,
      expected_thread_updated_at: thread.updatedAt
    });
    expect(resolved).toMatchObject({ resolved: true, changed: true });

    const gate = await lifecycle.mergeGatePrepare(exactInput("e2e-merge-gate", taskRepoId, finalHead, finalTree));
    expect(gate).toMatchObject({ eligible: true, blockers: [], approval_surface: "owner_cli" });
    if (!gate.manifest) throw new Error("merge gate was unexpectedly blocked");
    const approval = await approvals.create({
      gateId: gate.manifest.manifest_id,
      gateSha256: gate.manifest.manifest_sha256
    });
    const approvalPath = join(fixture.runtimeRoot, "owner-merge-approvals", `${approval.approvalId}.json`);
    expect((await stat(approvalPath)).mode & 0o777).toBe(0o600);

    const merged = await lifecycle.writeMerge({
      ...exactInput("e2e-write-merge", taskRepoId, finalHead, finalTree),
      manifest_id: gate.manifest.manifest_id,
      manifest_sha256: gate.manifest.manifest_sha256,
      approval_id: approval.approvalId
    });
    expect(merged).toMatchObject({
      approval_consumed: true,
      merge_method: "squash",
      merged_head_sha: finalHead,
      merge_commit_sha: MERGE_SHA
    });
    const readback = await lifecycle.postMergeReadback({
      ...exactInput("e2e-post-merge", taskRepoId, finalHead, finalTree),
      merge_operation_id: "e2e-write-merge"
    });
    expect(readback).toMatchObject({
      pull_request_confirmed: true,
      base_advanced: true,
      base_contains_merge_commit: true,
      task_branch_retained: true,
      main_ci_overall: "success",
      readback_state: "confirmed",
      task_disposition: "closure_ready"
    });

    const closed = await lifecycle.taskClose({
      ...exactInput("e2e-close-task", taskRepoId, finalHead, finalTree),
      outcome: "completed",
      summary: "Deterministic full lifecycle completed with confirmed post-merge state."
    });
    expect(closed.task.state).toBe("closed");
    const cleaned = await lifecycle.taskCleanup({
      ...exactInput("e2e-cleanup-task", taskRepoId, finalHead, finalTree),
      cleanup_scope: "workspace_and_artifacts"
    });
    expect(cleaned).toMatchObject({ state: "cleaned", workspace_removed: true });
    expect(await gitBare(fixture.bareRemote, "rev-parse", `refs/heads/${task.branch}`)).toBe(finalHead);
    await expect(stat(worktree)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

class LocalBareGitBoundary implements ExactGitBoundary {
  constructor(
    private readonly bareRemote: string,
    private readonly github: FakeGitHubAdapter
  ) {}

  async inspect(task: ServerOwnedTask): Promise<LocalGitSnapshot> {
    return {
      branch: await git(task.root, "branch", "--show-current"),
      headSha: await git(task.root, "rev-parse", "HEAD"),
      treeSha: await git(task.root, "rev-parse", "HEAD^{tree}"),
      clean: (await git(task.root, "status", "--porcelain=v1", "--untracked-files=all")) === "",
      pushUrls: ["https://github.com/example/project.git"]
    };
  }

  async isAncestor(task: ServerOwnedTask, ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      await git(task.root, "merge-base", "--is-ancestor", ancestorSha, descendantSha);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async pushExact(input: { task: ServerOwnedTask; expectedHeadSha: string; expectedRemoteUrl: string }): Promise<void> {
    if (input.expectedRemoteUrl !== "https://github.com/example/project.git") throw new Error("unexpected fixture remote");
    await git(input.task.root, "push", "--no-force", this.bareRemote, `${input.expectedHeadSha}:refs/heads/${input.task.branch}`);
    const tree = await git(input.task.root, "rev-parse", `${input.expectedHeadSha}^{tree}`);
    this.github.refs.set(`refs/heads/${input.task.branch}`, input.expectedHeadSha);
    this.github.refTrees.set(`refs/heads/${input.task.branch}`, tree);
    if (this.github.pullRequest.state === "OPEN") {
      this.github.pullRequest = { ...this.github.pullRequest, headSha: input.expectedHeadSha, updatedAt: "2026-08-23T00:02:00.000Z" };
      for (const thread of this.github.reviewThreads) thread.headSha = input.expectedHeadSha;
    }
  }
}

async function setupFixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "full-lifecycle-e2e-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const bareRemote = join(parent, "remote.git");
  const worktreeRoot = join(parent, "worktrees");
  const runtimeRoot = join(parent, "runtime");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Full Lifecycle Fixture");
  await git(ownerRoot, "config", "user.email", "fixture@example.invalid");
  await mkdir(join(ownerRoot, "src"));
  await writeFile(join(ownerRoot, "README.md"), "# Full lifecycle fixture\n");
  await writeFile(join(ownerRoot, "src", "value.ts"), "export const value = 0;\n");
  await writeFile(join(ownerRoot, "CHANGELOG.md"), "# Changes\n");
  await git(ownerRoot, "add", "--", "README.md", "CHANGELOG.md", "src/value.ts");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  await gitBare(parent, "init", "--bare", bareRemote);
  await git(ownerRoot, "remote", "add", "origin", bareRemote);
  const baseHead = await git(ownerRoot, "rev-parse", "HEAD");
  const baseTree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "fixture-owner",
      display_name: "Full lifecycle fixture",
      root: ownerRoot,
      lifecycle: {
        authority: "ship",
        remote_name: "origin",
        expected_remote_identity: "github.com/example/project",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        github_repository: "example/project",
        merge_method: "squash",
        required_checks: ["test"],
        independent_review_required: false,
        cleanup: {
          remove_worktree: true,
          delete_local_branch: true,
          require_terminal_task: true
        }
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  return { parent, ownerRoot, bareRemote, worktreeRoot, runtimeRoot, baseHead, baseTree, registry, bundle };
}

function configuredFakeGitHub(task: ServerOwnedTask, baseHead: string, baseTree: string): FakeGitHubAdapter {
  const github = new FakeGitHubAdapter();
  github.refs.clear();
  github.refTrees.clear();
  github.refs.set(`refs/heads/${task.baseBranch}`, baseHead);
  github.refTrees.set(`refs/heads/${task.baseBranch}`, baseTree);
  github.pullRequest = makePullRequest({
    state: "CLOSED",
    isDraft: true,
    headRefName: task.branch,
    headSha: baseHead,
    baseRefName: task.baseBranch,
    baseSha: baseHead,
    reviewDecision: undefined
  });
  github.mergePullRequest = async (): Promise<MergeApiResult> => {
    github.calls.push("mergePullRequest");
    github.pullRequest = {
      ...github.pullRequest,
      state: "MERGED",
      mergedAt: "2026-08-23T00:03:00.000Z",
      mergeCommitSha: MERGE_SHA
    };
    github.refs.set(`refs/heads/${task.baseBranch}`, MERGE_SHA);
    github.refTrees.set(`refs/heads/${task.baseBranch}`, github.refTrees.get(`refs/heads/${task.branch}`)!);
    configureSuccessfulCi(github, MERGE_SHA);
    return { merged: true, message: "MERGED", sha: MERGE_SHA };
  };
  return github;
}

function configureSuccessfulCi(github: FakeGitHubAdapter, headSha: string): void {
  github.checkRuns = {
    totalCount: 1,
    checkRuns: [{
      id: 10,
      name: "test",
      appSlug: "github-actions",
      headSha,
      status: "completed",
      conclusion: "success"
    }]
  };
  github.statuses = { sha: headSha, state: "success", statuses: [] };
  github.workflowRuns = [{
    id: 9001,
    headSha,
    attempt: 1,
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    event: "push",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:30.000Z",
    url: "https://github.com/example/project/actions/runs/9001",
    jobs: [{
      id: 9101,
      name: "test",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:29.000Z",
      url: "https://github.com/example/project/actions/runs/9001/job/9101",
      failureSummary: []
    }]
  }];
}

async function runMutation(
  fixture: Awaited<ReturnType<typeof setupFixture>>,
  repoId: string,
  operationId: string,
  head: string,
  tree: string,
  tool: "repo_write_changes" | "repo_write_file" | "repo_write_stage" | "repo_write_commit",
  action: () => Promise<void>
): Promise<void> {
  const result = await fixture.bundle.taskMutations.run(tool, {
    operation_id: operationId,
    repo_id: repoId,
    expected_head_sha: head,
    expected_tree_sha: tree
  }, async () => {
    await action();
    return { structuredContent: { ok: true, changed: true }, content: [{ type: "text", text: "Fixture mutation completed." }] };
  });
  expect(result.isError).not.toBe(true);
}

async function runValidation(
  fixture: Awaited<ReturnType<typeof setupFixture>>,
  repoId: string,
  operationId: string,
  head: string,
  tree: string
): Promise<void> {
  const result = await fixture.bundle.taskMutations.run("repo_validate", {
    operation_id: operationId,
    repo_id: repoId,
    expected_head_sha: head,
    expected_tree_sha: tree,
    profile: "all"
  }, async () => ({
    structuredContent: attachValidationArtifactCapture({
      ok: true,
      repo_id: repoId,
      validation_id: operationId,
      profile: "all",
      dry_run: false,
      status: "passed",
      commands: [],
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      warnings: []
    }, {
      schema_version: 1,
      validation_id: operationId,
      repo_id: repoId,
      profile: "all",
      status: "passed",
      commands: [{
        profile: "all",
        script: "fixture-validation",
        command: "deterministic in-process fixture validation",
        status: "passed",
        exit_code: 0,
        timed_out: false,
        duration_ms: 1,
        stdout: "fixture validation passed\n",
        stderr: ""
      }]
    }),
    content: [{ type: "text", text: "Fixture validation passed." }]
  }));
  expect(result.isError).not.toBe(true);
}

function exactInput(operationId: string, repoId: string, head: string, tree: string) {
  return {
    operation_id: operationId,
    repo_id: repoId,
    task_id: "e2e-task",
    expected_head_sha: head,
    expected_tree_sha: tree
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

async function gitBare(cwd: string, ...args: string[]): Promise<string> {
  return git(cwd, ...args);
}
