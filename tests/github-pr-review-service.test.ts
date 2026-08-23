import { describe, expect, it } from "vitest";
import { GitHubPrService } from "../src/services/github-pr-service.js";
import { GitHubReviewService } from "../src/services/github-review-service.js";
import {
  FIXED_TASK,
  FixedClock,
  FixedMergeEvidenceProvider,
  FixedTaskLookup,
  FakeGitBoundary,
  FakeGitHubAdapter,
  HEAD_SHA,
  MemoryArtifactSink,
  MemoryOperationLedger,
  TREE_SHA,
  makeReviewThread
} from "./fixtures/github-lifecycle-fixtures.js";

const input = (operationId: string) => ({
  operation_id: operationId,
  repo_id: FIXED_TASK.repoId,
  task_id: FIXED_TASK.taskId,
  expected_head_sha: HEAD_SHA,
  expected_tree_sha: TREE_SHA
});

describe("GitHub PR and review services", () => {
  it("leaves create-or-update Draft, binds the exact operation marker, and does not duplicate the write", async () => {
    const fixture = createFixture();
    const result = await fixture.pr.prCreateOrUpdate({
      ...input("pr-operation-1"),
      title: "Updated change",
      body: "Exact body",
      draft: true
    });
    expect(result).toMatchObject({
      disposition: "EXECUTED",
      action: "updated",
      pullRequest: {
        state: "OPEN",
        isDraft: true,
        headSha: HEAD_SHA,
        operationMarkers: ["pr-operation-1"]
      },
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(phases(fixture.ledger, "pr-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);
    expect(fixture.github.calls.filter((call) => call === "updatePullRequest")).toHaveLength(1);

    const duplicate = await fixture.pr.prCreateOrUpdate({
      ...input("pr-operation-1"),
      title: "Updated change",
      body: "Exact body",
      draft: true
    });
    expect(duplicate).toMatchObject({ disposition: "STORED", operation: { phase: "EXTERNAL_SUCCEEDED" } });
    expect(fixture.github.calls.filter((call) => call === "updatePullRequest")).toHaveLength(1);
  });

  it("reads exact-head threads, posts one exact reply, and resolves an exact observed version", async () => {
    const fixture = createFixture();
    fixture.github.reviewThreads = [makeReviewThread()];

    const observed = await fixture.review.prReviewThreads({ ...input("review-status-1"), limit: 25 });
    expect(observed).toMatchObject({
      disposition: "EXECUTED",
      pullRequestNumber: 7,
      truncated: false,
      threads: [{ id: "thread_1", headSha: HEAD_SHA, isResolved: false }],
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(phases(fixture.ledger, "review-status-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);

    const reply = await fixture.review.writePrReply({
      ...input("review-reply-1"),
      expected_head_sha: fixture.correctedHead,
      expected_tree_sha: fixture.correctedTree,
      thread_id: "thread_1",
      body: "Addressed in the exact head."
    });
    expect(reply).toMatchObject({
      disposition: "EXECUTED",
      threadId: "thread_1",
      created: true,
      comment: { body: "Addressed in the exact head." },
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });

    const resolved = await fixture.review.writePrResolveThread({
      ...input("review-resolve-1"),
      expected_head_sha: fixture.correctedHead,
      expected_tree_sha: fixture.correctedTree,
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    });
    expect(resolved).toMatchObject({
      disposition: "EXECUTED",
      thread: { id: "thread_1", isResolved: true },
      changed: true,
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(fixture.github.calls.filter((call) => call === "replyToReviewThread")).toHaveLength(1);
    expect(fixture.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(1);
  });

  it("resolves a same-head confirmation only after a durable reply and fresh validation", async () => {
    const fixture = createFixture(false);
    fixture.github.reviewThreads = [makeReviewThread()];
    await fixture.review.prReviewThreads({ ...input("review-status-confirmation"), limit: 25 });

    fixture.clock.advance(1_000);
    await fixture.review.writePrReply({
      ...input("review-reply-confirmation"),
      thread_id: "thread_1",
      body: "The final code and tests confirm the requested invariant."
    });

    fixture.clock.advance(1_000);
    fixture.evidence.validation = {
      status: "passed",
      headSha: HEAD_SHA,
      treeSha: TREE_SHA,
      validationId: "validation-after-confirmation",
      digest: "d".repeat(64),
      createdAt: fixture.clock.now().toISOString()
    };
    const resolved = await fixture.review.writePrResolveThread({
      ...input("review-resolve-confirmation"),
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    });

    expect(resolved).toMatchObject({
      disposition: "EXECUTED",
      thread: { id: "thread_1", isResolved: true },
      changed: true,
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(fixture.github.calls.filter((call) => call === "replyToReviewThread")).toHaveLength(1);
    expect(fixture.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(1);
  });

  it("refuses a same-head confirmation when validation predates the durable reply", async () => {
    const fixture = createFixture(false);
    fixture.github.reviewThreads = [makeReviewThread()];
    await fixture.review.prReviewThreads({ ...input("review-status-stale-validation"), limit: 25 });
    fixture.clock.advance(1_000);
    await fixture.review.writePrReply({
      ...input("review-reply-stale-validation"),
      thread_id: "thread_1",
      body: "The final code and tests confirm the requested invariant."
    });

    await expect(fixture.review.writePrResolveThread({
      ...input("review-resolve-stale-validation"),
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "REVIEW_CONFIRMATION_VALIDATION_STALE" });
    expect(fixture.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(0);
  });

  it("refuses a same-head confirmation without a durable pre-reply thread snapshot", async () => {
    const fixture = createFixture(false);
    fixture.github.reviewThreads = [makeReviewThread()];
    fixture.clock.advance(1_000);
    await fixture.review.writePrReply({
      ...input("review-reply-without-snapshot"),
      thread_id: "thread_1",
      body: "The final code and tests confirm the requested invariant."
    });
    fixture.clock.advance(1_000);
    fixture.evidence.validation = {
      status: "passed",
      headSha: HEAD_SHA,
      treeSha: TREE_SHA,
      validationId: "validation-after-unobserved-reply",
      digest: "e".repeat(64),
      createdAt: fixture.clock.now().toISOString()
    };

    await expect(fixture.review.writePrResolveThread({
      ...input("review-resolve-without-snapshot"),
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "REVIEW_CORRECTION_EVIDENCE_MISSING" });
    expect(fixture.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(0);
  });

  it("refuses resolution without corrected-head or same-head reply evidence and rejects an outdated thread", async () => {
    const unchanged = createFixture(false);
    unchanged.github.reviewThreads = [makeReviewThread()];
    await unchanged.review.prReviewThreads({ ...input("review-status-unchanged"), limit: 25 });
    await expect(unchanged.review.writePrResolveThread({
      ...input("review-resolve-unchanged"),
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "REVIEW_CORRECTION_EVIDENCE_MISSING" });
    expect(unchanged.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(0);

    const outdated = createFixture();
    outdated.github.reviewThreads = [makeReviewThread()];
    outdated.github.reviewThreads[0]!.isOutdated = true;
    await outdated.review.prReviewThreads({ ...input("review-status-outdated"), limit: 25 });
    await expect(outdated.review.writePrResolveThread({
      ...input("review-resolve-outdated"),
      expected_head_sha: outdated.correctedHead,
      expected_tree_sha: outdated.correctedTree,
      thread_id: "thread_1",
      expected_thread_updated_at: "2026-08-23T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "REVIEW_THREAD_OUTDATED" });
    expect(outdated.github.calls.filter((call) => call === "resolveReviewThread")).toHaveLength(0);
  });
});

function createFixture(advanceAfterObservation = true) {
  const tasks = new FixedTaskLookup();
  const git = new FakeGitBoundary();
  const github = new FakeGitHubAdapter();
  const artifacts = new MemoryArtifactSink();
  const ledger = new MemoryOperationLedger();
  const clock = new FixedClock();
  const evidence = new FixedMergeEvidenceProvider();
  const pr = new GitHubPrService(tasks, git, github, artifacts, ledger, clock);
  const review = new GitHubReviewService(tasks, git, github, evidence, artifacts, ledger, clock);
  const correctedHead = "6".repeat(40);
  const correctedTree = "7".repeat(40);
  const originalReviewThreads = review.prReviewThreads.bind(review);
  review.prReviewThreads = async (request) => {
    const result = await originalReviewThreads(request);
    if (!advanceAfterObservation) return result;
    git.snapshot.headSha = correctedHead;
    git.snapshot.treeSha = correctedTree;
    github.refs.set(`refs/heads/${FIXED_TASK.branch}`, correctedHead);
    github.refTrees.set(`refs/heads/${FIXED_TASK.branch}`, correctedTree);
    github.pullRequest.headSha = correctedHead;
    for (const thread of github.reviewThreads) thread.headSha = correctedHead;
    evidence.validation = {
      status: "passed",
      headSha: correctedHead,
      treeSha: correctedTree,
      validationId: "validation-corrected",
      digest: "c".repeat(64),
      createdAt: clock.now().toISOString()
    };
    return result;
  };
  return { tasks, git, github, artifacts, ledger, clock, evidence, pr, review, correctedHead, correctedTree };
}

function phases(ledger: MemoryOperationLedger, operationId: string): string[] {
  return ledger.history.filter((entry) => entry.operationId === operationId).map((entry) => entry.phase);
}
