import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { sha256Json, type GitHubOperationRecord } from "../src/github/types.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import {
  DurableGitHubOperationLedger,
  RegistryTaskLookup,
  TaskArtifactGitHubSink,
  TaskArtifactMergeEvidenceProvider
} from "../src/services/github-runtime-adapters.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { canonicalJson } from "../src/task-runtime/index.js";
import { FakeGitBoundary, FakeGitHubAdapter } from "./fixtures/github-lifecycle-fixtures.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production GitHub runtime adapters", () => {
  test("persists compare-and-set operation state across adapter reconstruction", async () => {
    const fixture = await setup();
    const ledger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const record: GitHubOperationRecord = {
      operationId: "github-operation-ledger",
      semantic: "repo_remote_status",
      repoId: fixture.task.repoId,
      taskId: fixture.task.taskId,
      subjectDigest: "1".repeat(64),
      bindingDigest: "2".repeat(64),
      phase: "CREATED",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z"
    };
    expect(await ledger.create(record)).toMatchObject({ created: true, record: { phase: "CREATED" } });
    await ledger.transition({
      operationId: record.operationId,
      bindingDigest: record.bindingDigest,
      expectedPhases: ["CREATED"],
      nextPhase: "ADMITTED",
      updatedAt: "2026-08-23T00:00:01.000Z"
    });

    const restarted = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    expect(await restarted.create(record)).toMatchObject({ created: false, record: { phase: "ADMITTED" } });
    expect(await restarted.listForTask({ repoId: fixture.task.repoId, taskId: fixture.task.taskId }))
      .toMatchObject([{ operationId: record.operationId, phase: "ADMITTED" }]);
  });

  test("serializes a subject lock across durable ledger instances", async () => {
    const fixture = await setup();
    const firstLedger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const secondLedger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const subject = {
      repoId: fixture.task.repoId,
      taskId: fixture.task.taskId,
      semantic: "repo_write_ci_retry_failed" as const,
      subjectDigest: "3".repeat(64)
    };
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = firstLedger.withSubjectLock(subject, async () => {
      order.push("first-enter");
      firstEntered();
      await release;
      order.push("first-exit");
    });
    await entered;
    const second = secondLedger.withSubjectLock(subject, async () => {
      order.push("second-enter");
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const enteredBeforeRelease = order.includes("second-enter");
    releaseFirst();
    await Promise.all([first, second]);

    expect(enteredBeforeRelease).toBe(false);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  test("stores GitHub JSON in the task CAS and resolves it only through a digest index", async () => {
    const fixture = await setup();
    const lookup = new RegistryTaskLookup(fixture.registry, fixture.bundle.tasks);
    const sink = new TaskArtifactGitHubSink(lookup, fixture.bundle.artifacts, fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const value = {
      semantic: "repo_remote_status",
      repoId: fixture.task.repoId,
      taskId: fixture.task.taskId,
      headSha: fixture.head
    } as const;
    const digest = sha256Json(value);
    const first = await sink.putJson({ namespace: "github-remote-evidence", digest, value, mode: 0o600 });
    const replay = await sink.putJson({ namespace: "github-remote-evidence", digest, value, mode: 0o600 });

    expect(replay).toEqual(first);
    expect(await sink.getJson({ namespace: "github-remote-evidence", digest })).toEqual(value);
    expect(await sink.reference(fixture.task.taskId, first.artifactId)).toMatchObject({
      artifact_id: first.artifactId,
      kind: "remote_observation",
      media_type: "application/json"
    });
  });

  test("selects only a passed validation artifact bound to the current exact head and tree", async () => {
    const fixture = await setup();
    const lookup = new RegistryTaskLookup(fixture.registry, fixture.bundle.tasks);
    const sink = new TaskArtifactGitHubSink(lookup, fixture.bundle.artifacts, fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const git = new FakeGitBoundary();
    git.snapshot = {
      branch: fixture.task.branch,
      headSha: fixture.head,
      treeSha: fixture.tree,
      clean: true,
      pushUrls: ["https://github.com/example/fixture.git"]
    };
    const provider = new TaskArtifactMergeEvidenceProvider(fixture.bundle.artifacts, git, new FakeGitHubAdapter(), sink);
    const payload = {
      schema_version: 1,
      task_id: fixture.task.taskId,
      operation_id: "validation-operation",
      expected_head_sha: fixture.head,
      expected_tree_sha: fixture.tree,
      resulting_head_sha: fixture.head,
      resulting_tree_sha: fixture.tree,
      validation: {
        schema_version: 1,
        validation_id: "validation-exact",
        repo_id: fixture.task.repoId,
        profile: "all",
        status: "passed",
        commands: []
      }
    } as const;
    const artifact = await fixture.bundle.artifacts.put({
      task_id: fixture.task.taskId,
      kind: "validation_log",
      media_type: "application/json",
      logical_path: "validation/validation-exact.json",
      content: `${canonicalJson(payload)}\n`
    });

    expect(await provider.getValidationEvidence(fixture.task)).toEqual({
      status: "passed",
      headSha: fixture.head,
      treeSha: fixture.tree,
      validationId: "validation-exact",
      digest: artifact.content_sha256
    });
    expect(await provider.getIndependentReviewEvidence(fixture.task)).toMatchObject({
      status: "passed",
      reviewId: "independent-review-not-required",
      materialFindingCount: 0
    });
  });
});

async function setup() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "github-runtime-adapters-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const worktreeRoot = join(parent, "worktrees");
  const runtimeRoot = join(parent, "runtime");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "GitHub Runtime Test");
  await git(ownerRoot, "config", "user.email", "runtime@example.com");
  await writeFile(join(ownerRoot, "README.md"), "# Fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const head = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner",
      root: ownerRoot,
      lifecycle: {
        authority: "ship",
        remote_name: "origin",
        expected_remote_identity: "https://github.com/example/fixture.git",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        github_repository: "example/fixture",
        merge_method: "squash",
        required_checks: [{ kind: "check_run", name: "test", app_slug: "github-actions" }],
        independent_review_required: false
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const opened = await bundle.lifecycle.taskOpen({
    operation_id: "open-github-runtime",
    repo_id: "owner",
    task_id: "github-runtime",
    base_branch: "main",
    base_commit_sha: head,
    base_tree_sha: tree,
    authority: "ship",
    goal: "Exercise production GitHub runtime adapters.",
    branch_slug: "github-runtime"
  });
  const lookup = new RegistryTaskLookup(registry, bundle.tasks);
  const task = await lookup.getServerOwnedTask(opened.task.repo_id);
  return { parent, ownerRoot, worktreeRoot, runtimeRoot, head, tree, registry, bundle, task };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
