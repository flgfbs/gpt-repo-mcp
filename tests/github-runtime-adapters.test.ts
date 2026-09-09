import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { sha256, sha256Json, type GitHubOperationRecord } from "../src/github/types.js";
import type { RuntimeContext } from "../src/runtime/context.js";
import { GitRemoteService, InstalledGitRunner, ProductionExactGitBoundary } from "../src/services/git-remote-service.js";
import { GitHubPushReconciliationService } from "../src/services/github-push-reconciliation-service.js";
import { GitHubLifecycleRuntime } from "../src/services/github-lifecycle-runtime.js";
import { RepositoryLifecycleRuntime } from "../src/services/repository-lifecycle-runtime.js";
import { writePushReconciliationHandler } from "../src/tools/handlers/lifecycle.js";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import {
  DurableGitHubOperationLedger,
  RegistryTaskLookup,
  TaskArtifactGitHubSink,
  TaskArtifactMergeEvidenceProvider
} from "../src/services/github-runtime-adapters.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { canonicalJson } from "../src/task-runtime/index.js";
import { BASE_SHA, BASE_TREE_SHA, FakeGitBoundary, FakeGitHubAdapter, FixedClock } from "./fixtures/github-lifecycle-fixtures.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production GitHub runtime adapters", () => {
  test.each(["digest", "symlink"])("native reconciliation survives reconstruction, preserves source operations and rejects %s tampering", async tamper => {
    const fixture = await setup();
    await git(fixture.task.root, "remote", "add", "origin", "https://github.com/example/fixture.git");
    const lookup = new RegistryTaskLookup(fixture.registry, fixture.bundle.tasks);
    const ledger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const sink = new TaskArtifactGitHubSink(lookup, fixture.bundle.artifacts, fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const boundary = new FakeGitBoundary();
    boundary.snapshot = { branch: fixture.task.branch, headSha: fixture.head, treeSha: fixture.tree,
      clean: true, pushUrls: ["https://github.com/example/fixture.git"] };
    const github = new FakeGitHubAdapter();
    github.repository.nameWithOwner = "example/fixture";
    const ref = "refs/heads/" + fixture.task.branch;
    github.refs.set(ref, BASE_SHA);
    github.refTrees.set(ref, BASE_TREE_SHA);
    const clock = new FixedClock();
    const remote = new GitRemoteService(lookup, boundary, github, sink, ledger, clock);
    const exact = { repo_id: fixture.task.repoId, task_id: fixture.task.taskId,
      expected_head_sha: fixture.head, expected_tree_sha: fixture.tree };
    await expect(remote.writePush({ ...exact, operation_id: "durable-unknown-push" })).rejects.toMatchObject({ code: "PUSH_READBACK_MISMATCH" });
    clock.advance(1000);
    github.refs.set(ref, fixture.head);
    github.refTrees.set(ref, fixture.tree);
    await remote.remoteStatus({ ...exact, operation_id: "durable-remote-observation" });
    clock.advance(1000);
    const original = (await ledger.readExact("durable-unknown-push"))!;
    const observation = (await ledger.readExact("durable-remote-observation"))!;
    const operationFile = (id: string) => join(fixture.runtimeRoot, "github-operations", sha256("github-operation\0" + id) + ".json");
    const originalBytes = await readFile(operationFile(original.record.operationId));
    const observationBytes = await readFile(operationFile(observation.record.operationId));
    expect(JSON.parse(originalBytes.toString()).state_sha256).toBe(original.stateSha256);
    // The native handler/runtime path uses real task lookup, local Git, durable ledger and CAS.
    // Only the external GitHub endpoint and the original fixture push are fake.
    const productionGit = new ProductionExactGitBoundary(new InstalledGitRunner(process.env));
    const service = new GitHubPushReconciliationService(lookup, productionGit, github, sink, ledger, clock);
    const unused = async (): Promise<never> => { throw new Error("Unexpected fixture lifecycle call"); };
    const external = new GitHubLifecycleRuntime(lookup, sink, {
      reconciliation: service, remote,
      pullRequests: { prCreateOrUpdate: unused, prStatus: unused },
      reviews: { prReviewThreads: unused, writePrReply: unused, writePrResolveThread: unused },
      ci: { ciStatus: unused, writeCiRetryFailed: unused }, gates: { mergeGatePrepare: unused },
      merge: { writeMerge: unused }, postMerge: { postMergeReadback: unused }
    });
    const lifecycle = new RepositoryLifecycleRuntime(fixture.registry, fixture.bundle.tasks, fixture.bundle.artifacts, external);
    const context = { lifecycle } as unknown as RuntimeContext;
    const input = { ...exact, operation_id: "durable-reconciliation",
      original_operation_id: original.record.operationId, original_head_sha: fixture.head, original_tree_sha: fixture.tree,
      observation_operation_id: observation.record.operationId };
    const preview = await writePushReconciliationHandler(input, context);
    expect(preview.structuredContent).toMatchObject({ ok: true, dry_run: true, recorded: false, artifact: null });
    expect(await ledger.readExact(input.operation_id)).toBeUndefined();
    const append = { ...input, dry_run: false, expected_original_state_sha256: original.stateSha256,
      expected_observation_state_sha256: observation.stateSha256 };
    const recorded = await writePushReconciliationHandler(append, context);
    expect(recorded.structuredContent).toMatchObject({ ok: true, dry_run: false, recorded: true,
      original_push_outcome: "UNKNOWN", original_fence_preserved: true, push_replayed: false,
      artifact: { kind: "push_receipt" } });
    expect((await writePushReconciliationHandler(append, context)).structuredContent).toEqual(recorded.structuredContent);
    expect(await readFile(operationFile(original.record.operationId))).toEqual(originalBytes);
    expect(await readFile(operationFile(observation.record.operationId))).toEqual(observationBytes);
    expect(boundary.pushCalls).toBe(1);
    expect(JSON.stringify(recorded)).not.toContain(fixture.parent);
    const restartedLedger = new DurableGitHubOperationLedger(fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const restartedSink = new TaskArtifactGitHubSink(lookup, fixture.bundle.artifacts, fixture.bundle.tasks.fs, fixture.bundle.tasks.locks);
    const restarted = new GitHubPushReconciliationService(lookup, productionGit, github, restartedSink, restartedLedger, clock);
    expect(await restarted.resolves(fixture.task, original.record, fixture.head, fixture.tree)).toBe(true);
    const path = operationFile(observation.record.operationId);
    if (tamper === "digest") {
      const changed = JSON.parse(observationBytes.toString());
      changed.updatedAt = clock.now().toISOString();
      await writeFile(path, JSON.stringify(changed));
    } else {
      const target = join(fixture.parent, "displaced-observation.json");
      await rename(path, target);
      await symlink(target, path);
    }
    expect(await restarted.resolves(fixture.task, original.record, fixture.head, fixture.tree)).toBe(false);
    expect((await writePushReconciliationHandler(append, context)).isError).toBe(true);
    expect(await readFile(operationFile(original.record.operationId))).toEqual(originalBytes);
    expect(boundary.pushCalls).toBe(1);
  });

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
      digest: artifact.content_sha256,
      createdAt: artifact.created_at
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
        expected_remote_identity: "github.com/example/fixture",
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
