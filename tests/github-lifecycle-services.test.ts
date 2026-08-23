import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      mergedHeadSha: HEAD_SHA,
      mergeCommitSha: MERGE_SHA,
      baseHeadSha: MERGE_SHA,
      taskBranchHeadSha: HEAD_SHA,
      taskBranchRetained: true,
      baseContainsMergeCommit: true,
      readbackState: "confirmed",
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
      workflowName: "CI"
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
  const postMerge = new GitHubPostMergeService(tasks, git, github, artifacts, ledger, clock);
  return { tasks, git, github, artifacts, ledger, clock, evidence, ci, gate, approvals, merge, postMerge };
}

function phases(ledger: MemoryOperationLedger, operationId: string): string[] {
  return ledger.history.filter((entry) => entry.operationId === operationId).map((entry) => entry.phase);
}
