import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json, type JsonValue, type WorkflowRun } from "../src/github/types.js";
import { OwnerApprovalStore } from "../src/github/owner-approval-store.js";
import { GitHubCiService } from "../src/services/github-ci-service.js";
import { GitHubMergeGateService } from "../src/services/github-merge-gate-service.js";
import { GitHubMergeService } from "../src/services/github-merge-service.js";
import { GitHubPostMergeService } from "../src/services/github-post-merge-service.js";
import {
  BASE_SHA,
  FIXED_TASK,
  FixedClock,
  FixedMergeEvidenceProvider,
  FixedTaskLookup,
  FakeGitBoundary,
  FakeGitHubAdapter,
  HEAD_SHA,
  MERGE_SHA,
  MemoryArtifactSink,
  MemoryOperationLedger,
  TREE_SHA
} from "./fixtures/github-lifecycle-fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const exactInput = (operationId: string) => ({
  operation_id: operationId,
  repo_id: FIXED_TASK.repoId,
  task_id: FIXED_TASK.taskId,
  expected_head_sha: HEAD_SHA,
  expected_tree_sha: TREE_SHA
});

describe("GitHub lifecycle services", () => {
  it("aggregates equivalent required check runs from multiple GitHub Actions suites", async () => {
    const fixture = await createLifecycleFixture();
    const first = fixture.github.checkRuns.checkRuns[0]!;
    fixture.github.checkRuns = {
      totalCount: 2,
      checkRuns: [
        { ...structuredClone(first), id: 11 },
        structuredClone(first)
      ]
    };

    const result = await fixture.ci.ciStatus(exactInput("ci-status-duplicate-success"));

    if (result.disposition !== "EXECUTED") throw new Error("unexpected stored CI status");
    expect(result.evidence.overall).toBe("success");
    expect(result.evidence.requiredChecks).toEqual([{
      key: "check:github-actions:test",
      required: { kind: "check_run", name: "test", appSlug: "github-actions" },
      status: "success",
      sourceIds: [10, 11],
      conclusion: "success"
    }]);
  });

  it("fails closed when duplicate required check runs disagree", async () => {
    const fixture = await createLifecycleFixture();
    const first = fixture.github.checkRuns.checkRuns[0]!;
    fixture.github.checkRuns = {
      totalCount: 2,
      checkRuns: [
        { ...structuredClone(first), id: 11, conclusion: "failure" },
        structuredClone(first)
      ]
    };

    await expect(fixture.ci.ciStatus(exactInput("ci-status-duplicate-conflict"))).rejects.toMatchObject({
      code: "CI_REQUIRED_CHECK_AMBIGUOUS"
    });
    expect(phases(fixture.ledger, "ci-status-duplicate-conflict")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "FAILED_KNOWN_AFTER_CONTACT"
    ]);
  });

  it("fails closed when duplicate required check runs have different raw statuses", async () => {
    const fixture = await createLifecycleFixture();
    const first = fixture.github.checkRuns.checkRuns[0]!;
    const pending = { ...structuredClone(first), id: 11, status: "in_progress" as const };
    delete pending.conclusion;
    fixture.github.checkRuns = {
      totalCount: 2,
      checkRuns: [pending, structuredClone(first)]
    };

    await expect(fixture.ci.ciStatus(exactInput("ci-status-duplicate-pending"))).rejects.toMatchObject({
      code: "CI_REQUIRED_CHECK_AMBIGUOUS"
    });
    expect(phases(fixture.ledger, "ci-status-duplicate-pending")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "FAILED_KNOWN_AFTER_CONTACT"
    ]);
  });

  it.each([
    { label: "non-array", sourceId: null, sourceIds: 5 },
    { label: "non-positive", sourceId: null, sourceIds: [0] },
    { label: "non-integer", sourceId: null, sourceIds: [1.5] },
    { label: "non-number", sourceId: null, sourceIds: ["10"] },
    { label: "duplicate", sourceId: null, sourceIds: [10, 10] },
    { label: "descending", sourceId: null, sourceIds: [11, 10] },
    { label: "invalid-singular", sourceId: 0, sourceIds: undefined },
    { label: "inconsistent-singular", sourceId: 5, sourceIds: [1, 2, 3] }
  ] satisfies Array<{
    label: string;
    sourceId: JsonValue | undefined;
    sourceIds: JsonValue | undefined;
  }>)("rejects invalid stored required-check source identity: $label", async ({ sourceId, sourceIds }) => {
    const fixture = await createLifecycleFixture();
    const ciStatusId = await storeCiSnapshot(fixture, { sourceId, sourceIds, status: "failure" });

    await expect(fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-invalid-sources"),
      ci_status_id: ciStatusId,
      failed_run_ids: ["9001"]
    })).rejects.toMatchObject({ code: "CI_SNAPSHOT_INVALID" });
    expect(fixture.github.calls.filter((call) => call === "retryFailedJobs")).toHaveLength(0);
  });

  it.each([
    { label: "legacy singular", sourceId: 10, sourceIds: undefined, status: "failure" as const },
    { label: "empty missing", sourceId: null, sourceIds: [], status: "missing" as const },
    { label: "aggregate", sourceId: null, sourceIds: [10, 11], status: "failure" as const }
  ] satisfies Array<{
    label: string;
    sourceId: JsonValue | undefined;
    sourceIds: JsonValue | undefined;
    status: "failure" | "missing";
  }>)("loads a valid stored required-check source identity: $label", async ({ sourceId, sourceIds, status }) => {
    const fixture = await createLifecycleFixture();
    const ciStatusId = await storeCiSnapshot(fixture, { sourceId, sourceIds, status });

    const result = await fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-valid-sources"),
      ci_status_id: ciStatusId,
      failed_run_ids: ["9001"]
    });

    expect(result).toMatchObject({ disposition: "EXECUTED", ciStatusId });
    expect(fixture.github.calls.filter((call) => call === "retryFailedJobs")).toHaveLength(1);
  });

  it.each(["merge", "squash", "rebase"] as const)(
    "prepares an OPEN Draft exact-head gate, merges with %s, and confirms retained-branch readback",
    async (mergeMethod) => {
    const fixture = await createLifecycleFixture(mergeMethod);
    const prepared = await fixture.gate.mergeGatePrepare(exactInput("gate-operation-1"));
    expect(prepared).toMatchObject({
      disposition: "EXECUTED",
      eligible: true,
      ownerCommand: expect.stringMatching(/^chat-pro-repo approve-merge --gate-id merge_manifest_[a-f0-9]{64}$/),
      manifest: {
        repositoryId: "R_repo_node",
        repositoryNameWithOwner: "example/project",
        pullRequestState: "OPEN",
        pullRequestDraft: true,
        pullRequestMergeable: "MERGEABLE",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        treeSha: TREE_SHA,
        mergeMethod,
        deleteTaskBranch: false,
        retainTaskBranch: true,
        materialFindingCount: 0,
        postMergePlan: {
          readbackRequired: true,
          retainTaskBranch: true,
          verifyBaseContainsHead: true
        }
      }
    });
    if (prepared.disposition !== "EXECUTED" || !prepared.eligible) throw new Error("gate unexpectedly blocked");
    expect(prepared.operation.phase).toBe("EXTERNAL_SUCCEEDED");
    expect(phases(fixture.ledger, "gate-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED",
      "LOCAL_MUTATION_STARTED", "LOCAL_MUTATION_COMPLETE", "EXTERNAL_SUCCEEDED"
    ]);
    expect(prepared.ownerCommand).toBe(`chat-pro-repo approve-merge --gate-id ${prepared.manifest.manifestId}`);

    const approval = await fixture.approvals.create({
      gateId: prepared.manifest.manifestId,
      gateSha256: prepared.manifest.manifestSha256
    });
    const merged = await fixture.merge.writeMerge({
      ...exactInput("merge-operation-1"),
      manifest_id: prepared.manifest.manifestId,
      manifest_sha256: prepared.manifest.manifestSha256,
      approval_id: approval.approvalId
    });
    expect(merged).toMatchObject({
      disposition: "EXECUTED",
      approvalConsumed: true,
      mergeMethod,
      mergedHeadSha: HEAD_SHA,
      mergeCommitSha: MERGE_SHA,
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(fixture.github.calls.filter((call) => call === "markPullRequestReady")).toHaveLength(1);
    expect(fixture.github.calls.filter((call) => call === "mergePullRequest")).toHaveLength(1);
    expect(fixture.github.refs.get(`refs/heads/${FIXED_TASK.branch}`)).toBe(HEAD_SHA);
    expect(phases(fixture.ledger, "merge-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED",
      "LOCAL_MUTATION_STARTED", "LOCAL_MUTATION_COMPLETE",
      "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);

    const readback = await fixture.postMerge.postMergeReadback({
      ...exactInput("readback-operation-1"),
      merge_operation_id: "merge-operation-1"
    });
    expect(readback).toMatchObject({
      disposition: "EXECUTED",
      mergeOperationId: "merge-operation-1",
      pullRequestConfirmed: true,
      mergedHeadSha: HEAD_SHA,
      mergeCommitSha: MERGE_SHA,
      expectedBaseSha: BASE_SHA,
      baseHeadSha: MERGE_SHA,
      baseHeadTreeSha: TREE_SHA,
      taskBranchHeadSha: HEAD_SHA,
      taskBranchTreeSha: TREE_SHA,
      taskBranchRetained: true,
      baseAdvanced: true,
      baseContainsMergeCommit: true,
      mainCi: { overall: "success", headSha: MERGE_SHA },
      readbackState: "confirmed",
      taskDisposition: "closure_ready",
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(phases(fixture.ledger, "readback-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);
    }
  );

  it("retries exactly one evidenced transient first-attempt run and never retries it again", async () => {
    const fixture = await createLifecycleFixture();
    fixture.github.checkRuns.checkRuns[0]!.conclusion = "timed_out";
    fixture.github.workflowRuns = [{
      id: 9001,
      headSha: HEAD_SHA,
      attempt: 1,
      status: "completed",
      conclusion: "timed_out",
      workflowName: "CI",
      event: "push",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:30.000Z",
      url: "https://github.com/example/project/actions/runs/9001",
      jobs: [{
        id: 9101,
        name: "test",
        status: "completed",
        conclusion: "timed_out",
        startedAt: "2026-08-23T00:00:01.000Z",
        completedAt: "2026-08-23T00:00:29.000Z",
        url: "https://github.com/example/project/actions/runs/9001/job/9101",
        failureSummary: ["step 1: test (timed_out)"]
      }]
    }];
    const status = await fixture.ci.ciStatus(exactInput("ci-status-operation"));
    if (status.disposition !== "EXECUTED") throw new Error("unexpected stored CI status");
    expect(status.evidence.overall).toBe("failure");

    const retried = await fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-operation-1"),
      ci_status_id: status.evidence.ciStatusId,
      failed_run_ids: ["9001"]
    });
    expect(retried).toMatchObject({
      disposition: "EXECUTED",
      retriedRunIds: ["9001"],
      skippedRunIds: [],
      changed: true,
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(fixture.github.calls.filter((call) => call === "retryFailedJobs")).toHaveLength(1);
    expect(phases(fixture.ledger, "ci-retry-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED",
      "LOCAL_MUTATION_STARTED", "LOCAL_MUTATION_COMPLETE",
      "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);

    await expect(fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-operation-2"),
      ci_status_id: status.evidence.ciStatusId,
      failed_run_ids: ["9001"]
    })).rejects.toMatchObject({ code: "CI_RETRY_ALREADY_CONSUMED" });
    expect(fixture.github.calls.filter((call) => call === "retryFailedJobs")).toHaveLength(1);

    await expect(fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-operation-3"),
      ci_status_id: status.evidence.ciStatusId,
      failed_run_ids: ["9001", "9002"]
    })).rejects.toMatchObject({ code: "ONE_CI_RUN_REQUIRED" });
  });

  it("serializes concurrent retry operations for the same exact workflow run", async () => {
    const fixture = await createLifecycleFixture();
    fixture.github.checkRuns.checkRuns[0]!.conclusion = "timed_out";
    fixture.github.workflowRuns = [{
      id: 9001,
      headSha: HEAD_SHA,
      attempt: 1,
      status: "completed",
      conclusion: "timed_out",
      workflowName: "CI",
      event: "push",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:30.000Z",
      url: "https://github.com/example/project/actions/runs/9001",
      jobs: [{
        id: 9101,
        name: "test",
        status: "completed",
        conclusion: "timed_out",
        startedAt: "2026-08-23T00:00:01.000Z",
        completedAt: "2026-08-23T00:00:29.000Z",
        url: "https://github.com/example/project/actions/runs/9001/job/9101",
        failureSummary: ["step 1: test (timed_out)"]
      }]
    }];
    const status = await fixture.ci.ciStatus(exactInput("ci-status-concurrent"));
    if (status.disposition !== "EXECUTED") throw new Error("unexpected stored CI status");

    let enteredRetry!: () => void;
    let releaseRetry!: () => void;
    const entered = new Promise<void>((resolve) => { enteredRetry = resolve; });
    const release = new Promise<void>((resolve) => { releaseRetry = resolve; });
    fixture.github.beforeRetryFailedJobs = async () => {
      enteredRetry();
      await release;
    };
    const first = fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-concurrent-1"),
      ci_status_id: status.evidence.ciStatusId,
      failed_run_ids: ["9001"]
    });
    await entered;
    const second = fixture.ci.writeCiRetryFailed({
      ...exactInput("ci-retry-concurrent-2"),
      ci_status_id: status.evidence.ciStatusId,
      failed_run_ids: ["9001"]
    });
    releaseRetry();

    await expect(first).resolves.toMatchObject({ disposition: "EXECUTED", retriedRunIds: ["9001"] });
    await expect(second).rejects.toMatchObject({ code: "CI_RETRY_ALREADY_CONSUMED" });
    expect(fixture.github.calls.filter((call) => call === "retryFailedJobs")).toHaveLength(1);
  });

  it("marks a Ready-only partial merge UNKNOWN_AFTER_CONTACT and never replays it", async () => {
    const fixture = await createLifecycleFixture();
    const prepared = await fixture.gate.mergeGatePrepare(exactInput("gate-operation-2"));
    if (prepared.disposition !== "EXECUTED" || !prepared.eligible) throw new Error("gate unexpectedly blocked");
    const approval = await fixture.approvals.create({
      gateId: prepared.manifest.manifestId,
      gateSha256: prepared.manifest.manifestSha256
    });
    fixture.github.failNext(
      "mergePullRequest",
      new Error("simulated response loss without provider output")
    );
    const input = {
      ...exactInput("merge-operation-unknown"),
      manifest_id: prepared.manifest.manifestId,
      manifest_sha256: prepared.manifest.manifestSha256,
      approval_id: approval.approvalId
    };

    await expect(fixture.merge.writeMerge(input)).rejects.toMatchObject({
      code: "MERGE_PARTIAL_READY_ONLY",
      operation: { phase: "UNKNOWN_AFTER_CONTACT" }
    });
    const readyCalls = fixture.github.calls.filter((call) => call === "markPullRequestReady").length;
    const mergeCalls = fixture.github.calls.filter((call) => call === "mergePullRequest").length;

    const duplicate = await fixture.merge.writeMerge(input);
    expect(duplicate).toMatchObject({ disposition: "STORED", operation: { phase: "UNKNOWN_AFTER_CONTACT" } });
    expect(fixture.github.calls.filter((call) => call === "markPullRequestReady")).toHaveLength(readyCalls);
    expect(fixture.github.calls.filter((call) => call === "mergePullRequest")).toHaveLength(mergeCalls);

    const nextGate = await fixture.gate.mergeGatePrepare(exactInput("gate-after-unknown"));
    expect(nextGate).toMatchObject({
      disposition: "EXECUTED",
      eligible: false,
      blockers: expect.arrayContaining([{ code: "UNKNOWN_EXTERNAL_EFFECT", message: expect.any(String) }]),
      manifest: null
    });
  });
});

async function createLifecycleFixture(mergeMethod: "merge" | "squash" | "rebase" = "squash") {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "github-lifecycle-"));
  temporaryRoots.push(runtimeRoot);
  const tasks = new FixedTaskLookup({ ...FIXED_TASK, mergeMethod });
  const git = new FakeGitBoundary();
  const github = new FakeGitHubAdapter();
  const artifacts = new MemoryArtifactSink();
  const ledger = new MemoryOperationLedger();
  const clock = new FixedClock();
  const evidence = new FixedMergeEvidenceProvider();
  const ci = new GitHubCiService(tasks, git, github, artifacts, ledger, clock);
  const gate = new GitHubMergeGateService(tasks, git, github, ci, evidence, artifacts, ledger, clock);
  const approvals = new OwnerApprovalStore(
    { getRuntimeRoot: async () => runtimeRoot },
    clock,
    { createOpaqueId: () => "ABCDEFGHIJKLMNOPQRSTUVWX" }
  );
  const merge = new GitHubMergeService(tasks, git, github, gate, approvals, artifacts, ledger, clock);
  const postMerge = new GitHubPostMergeService(tasks, git, github, ci, artifacts, ledger, clock);
  return { tasks, git, github, artifacts, ledger, clock, evidence, ci, gate, approvals, merge, postMerge };
}

function phases(ledger: MemoryOperationLedger, operationId: string): string[] {
  return ledger.history.filter((entry) => entry.operationId === operationId).map((entry) => entry.phase);
}

async function storeCiSnapshot(
  fixture: Awaited<ReturnType<typeof createLifecycleFixture>>,
  input: {
    sourceId: JsonValue | undefined;
    sourceIds: JsonValue | undefined;
    status: "failure" | "missing";
  }
): Promise<string> {
  const run: WorkflowRun = {
    id: 9001,
    headSha: HEAD_SHA,
    attempt: 1,
    status: "completed",
    conclusion: "timed_out",
    workflowName: "CI",
    event: "push",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:30.000Z",
    url: "https://github.com/example/project/actions/runs/9001",
    jobs: []
  };
  fixture.github.workflowRuns = [structuredClone(run)];
  const requiredCheck: Record<string, JsonValue> = {
    key: "check:github-actions:test",
    required: { kind: "check_run", name: "test", appSlug: "github-actions" },
    status: input.status,
    conclusion: input.status === "failure" ? "timed_out" : null
  };
  if (input.sourceId !== undefined) requiredCheck.sourceId = input.sourceId;
  if (input.sourceIds !== undefined) requiredCheck.sourceIds = input.sourceIds;
  const snapshot: JsonValue = {
    semantic: "repo_ci_status",
    repoId: FIXED_TASK.repoId,
    taskId: FIXED_TASK.taskId,
    headSha: HEAD_SHA,
    overall: "failure",
    requiredChecks: [requiredCheck],
    workflowRuns: [{
      id: run.id,
      headSha: run.headSha,
      attempt: run.attempt,
      status: run.status,
      conclusion: run.conclusion ?? null,
      workflowName: run.workflowName,
      event: run.event,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      url: run.url,
      jobs: []
    }],
    observedAt: "2026-08-23T00:00:31.000Z"
  };
  const digest = sha256Json(snapshot);
  await fixture.artifacts.putJson({
    namespace: "github-ci-evidence",
    digest,
    value: snapshot,
    mode: 0o600
  });
  return `ci_status_${digest}`;
}
