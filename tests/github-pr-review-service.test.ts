import { describe, expect, it } from "vitest";
import { GitHubPrService } from "../src/services/github-pr-service.js";
import { GitHubReviewService } from "../src/services/github-review-service.js";
import {
  FIXED_TASK,
  FixedClock,
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
});

function createFixture() {
  const tasks = new FixedTaskLookup();
  const git = new FakeGitBoundary();
  const github = new FakeGitHubAdapter();
  const artifacts = new MemoryArtifactSink();
  const ledger = new MemoryOperationLedger();
  const clock = new FixedClock();
  const pr = new GitHubPrService(tasks, git, github, artifacts, ledger, clock);
  const review = new GitHubReviewService(tasks, git, github, artifacts, ledger, clock);
  return { tasks, git, github, artifacts, ledger, clock, pr, review };
}

function phases(ledger: MemoryOperationLedger, operationId: string): string[] {
  return ledger.history.filter((entry) => entry.operationId === operationId).map((entry) => entry.phase);
}
