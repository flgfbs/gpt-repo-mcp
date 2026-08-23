import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import {
  assertExactRemoteHead,
  bindExactTask,
  getUniqueTaskPullRequest,
  listAllExactReviewThreads,
  type ExactTaskInput
} from "../github/exact-task.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import {
  GitHubBoundaryError,
  assertSafeExternalText,
  sha256,
  sha256Json,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type JsonValue,
  type MergeEvidenceProvider,
  type PullRequestSnapshot,
  type ReviewComment,
  type ReviewReplyReceipt,
  type ReviewThread,
  type ServerOwnedTask,
  type TaskLookup
} from "../github/types.js";

export type ReviewThreadsResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      ok: true;
      semantic: "repo_pr_review_threads";
      operation_id: string;
      repo_id: string;
      task_id: string;
      pullRequestNumber: number;
      threads: ReviewThread[];
      nextCursor?: string;
      truncated: boolean;
      observedAt: string;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export type ReviewReplyResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      pullRequestNumber: number;
      threadId: string;
      comment: ReviewComment;
      created: true;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export type ReviewResolveResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      pullRequestNumber: number;
      thread: ReviewThread;
      changed: boolean;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export class GitHubReviewService {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly evidenceProvider: MergeEvidenceProvider,
    private readonly artifacts: ContentAddressedArtifactSink,
    private readonly ledger: DurableOperationLedger,
    private readonly clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async prReviewThreads(input: ExactTaskInput & { cursor?: string; limit?: number }): Promise<ReviewThreadsResult> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new GitHubBoundaryError("INVALID_REVIEW_LIMIT", "Review thread limit must be between 1 and 100.");
    }
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: false });
    const cursor = input.cursor ? assertCursor(input.cursor) : undefined;
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_pr_review_threads",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch, cursor: cursor ?? null },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        cursor: cursor ?? null,
        limit
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const { pullRequest } = await this.bindPullRequest(input, false);
      const page = await this.github.listReviewThreadsPage({
        repository: task.repository,
        pullRequestNumber: pullRequest.number,
        limit,
        ...(cursor ? { cursor } : {})
      });
      assertReviewPage(pullRequest, page);
      const observedAt = this.clock.now().toISOString();
      const evidenceValue = {
        semantic: "repo_pr_review_threads",
        repoId: task.repoId,
        taskId: task.taskId,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        threads: page.threads.map(reviewThreadEvidence),
        nextCursor: page.nextCursor ?? null,
        observedAt
      } as const;
      const evidence = await storeGitHubEvidence(this.artifacts, "github-review-evidence", evidenceValue);
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          pullRequestNumber: pullRequest.number,
          threadCount: page.threads.length,
          nextCursor: page.nextCursor ?? null,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        ok: true,
        semantic: "repo_pr_review_threads",
        operation_id: input.operation_id,
        repo_id: task.repoId,
        task_id: task.taskId,
        pullRequestNumber: pullRequest.number,
        threads: page.threads,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        truncated: page.nextCursor !== undefined,
        observedAt,
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
  }

  async writePrReply(input: ExactTaskInput & { thread_id: string; body: string }): Promise<ReviewReplyResult> {
    const body = assertSafeExternalText(input.body, "review reply body");
    if (body.length > 65_536) throw new GitHubBoundaryError("REVIEW_REPLY_TOO_LARGE", "Review reply exceeds the fixed size limit.");
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_write_pr_reply",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { threadId: input.thread_id },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        threadId: input.thread_id,
        bodyDigest: sha256(body)
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let pullRequest: PullRequestSnapshot;
    let thread: ReviewThread;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      ({ pullRequest } = await this.bindPullRequest(input, true));
      thread = await this.findExactThread(task, pullRequest, input.thread_id);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    let receipt: ReviewReplyReceipt;
    try {
      receipt = await this.github.replyToReviewThread({
        repository: task.repository,
        threadId: thread.id,
        body,
        operationMarker: input.operation_id
      });
      if (
        receipt.threadId !== thread.id
        || receipt.operationMarker !== input.operation_id
        || receipt.comment.body !== body
      ) {
        throw new GitHubBoundaryError("REVIEW_REPLY_READBACK_MISMATCH", "Review reply receipt does not match the exact write.", "UNKNOWN");
      }
    } catch (error) {
      const phase = error instanceof GitHubBoundaryError && error.effect === "KNOWN"
        ? "FAILED_KNOWN_AFTER_CONTACT"
        : "UNKNOWN_AFTER_CONTACT";
      operation = await this.operations.transition(operation, phase, { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
    try {
      const evidence = await storeGitHubEvidence(this.artifacts, "github-review-evidence", {
        semantic: "repo_write_pr_reply",
        repoId: task.repoId,
        taskId: task.taskId,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        threadId: thread.id,
        comment: reviewCommentEvidence(receipt.comment)
      });
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          pullRequestNumber: pullRequest.number,
          threadId: thread.id,
          commentId: receipt.comment.id,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        pullRequestNumber: pullRequest.number,
        threadId: thread.id,
        comment: receipt.comment,
        created: true,
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
        result: {
          pullRequestNumber: pullRequest.number,
          threadId: thread.id,
          commentId: receipt.comment.id,
          created: true
        },
        failureCode: "REVIEW_EVIDENCE_STORE_FAILED"
      });
      throw operationError(error, operation);
    }
  }

  async writePrResolveThread(input: ExactTaskInput & {
    thread_id: string;
    expected_thread_updated_at: string;
  }): Promise<ReviewResolveResult> {
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_write_pr_resolve_thread",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { threadId: input.thread_id },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        threadId: input.thread_id,
        expectedThreadUpdatedAt: input.expected_thread_updated_at
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let pullRequest: PullRequestSnapshot;
    let before: ReviewThread;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      ({ pullRequest } = await this.bindPullRequest(input, true));
      before = await this.findExactThread(task, pullRequest, input.thread_id);
      if (before.updatedAt !== input.expected_thread_updated_at) {
        throw new GitHubBoundaryError("REVIEW_THREAD_VERSION_DRIFT", "Review thread changed after the caller observed it.");
      }
      if (before.isOutdated) throw new GitHubBoundaryError("REVIEW_THREAD_OUTDATED", "Outdated review threads cannot be mutated.");
      await this.assertResolutionEvidence(task, before, input.expected_head_sha, input.expected_tree_sha);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    if (before.isResolved) {
      try {
        const evidence = await this.storeResolveEvidence(task, pullRequest, before, false);
        operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
          result: resolveOperationResult(pullRequest, before, false, evidence)
        });
        return { disposition: "EXECUTED", operation, pullRequestNumber: pullRequest.number, thread: before, changed: false, evidence };
      } catch (error) {
        operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
        throw operationError(error, operation);
      }
    }

    let resolvedReceipt: ReviewThread | undefined;
    try {
      const after = await this.github.resolveReviewThread({ repository: task.repository, threadId: before.id });
      assertResolvedThread(pullRequest, before.id, after);
      resolvedReceipt = after;
      const evidence = await this.storeResolveEvidence(task, pullRequest, after, true);
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: resolveOperationResult(pullRequest, after, true, evidence)
      });
      return { disposition: "EXECUTED", operation, pullRequestNumber: pullRequest.number, thread: after, changed: true, evidence };
    } catch (error) {
      if (resolvedReceipt) {
        operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
          result: {
            pullRequestNumber: pullRequest.number,
            threadId: resolvedReceipt.id,
            resolved: true,
            changed: true,
            updatedAt: resolvedReceipt.updatedAt
          },
          failureCode: "REVIEW_EVIDENCE_STORE_FAILED"
        });
        throw operationError(error, operation);
      }
      try {
        const after = await this.findExactThread(task, pullRequest, before.id);
        if (after.isResolved) {
          const evidence = await this.storeResolveEvidence(task, pullRequest, after, true);
          operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
            result: { ...resolveOperationResult(pullRequest, after, true, evidence), reconciled: true }
          });
          return { disposition: "EXECUTED", operation, pullRequestNumber: pullRequest.number, thread: after, changed: true, evidence };
        }
        if (after.updatedAt === before.updatedAt) {
          operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
            failureCode: "REVIEW_RESOLVE_KNOWN_NO_EFFECT"
          });
          throw operationError(
            new GitHubBoundaryError("REVIEW_RESOLVE_KNOWN_NO_EFFECT", "Review thread remained unresolved after contact.", "KNOWN"),
            operation
          );
        }
      } catch (readbackError) {
        if (isOperationError(readbackError)) throw readbackError;
      }
      operation = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
        failureCode: errorCode(error)
      });
      throw operationError(error, operation);
    }
  }

  private async bindPullRequest(input: ExactTaskInput, requireClean: boolean): Promise<{
    task: ServerOwnedTask;
    pullRequest: PullRequestSnapshot;
  }> {
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean });
    await assertExactRemoteHead(this.github, task, input.expected_head_sha, input.expected_tree_sha);
    const pullRequest = await getUniqueTaskPullRequest({
      github: this.github,
      task,
      expectedHeadSha: input.expected_head_sha,
      requireDraft: false
    });
    return { task, pullRequest };
  }

  private async findExactThread(task: ServerOwnedTask, pullRequest: PullRequestSnapshot, threadId: string): Promise<ReviewThread> {
    const matches = (await listAllExactReviewThreads({ github: this.github, task, pullRequest }))
      .filter((thread) => thread.id === threadId);
    if (matches.length !== 1) throw new GitHubBoundaryError("REVIEW_THREAD_NOT_FOUND", "The exact review thread was not found once.");
    return matches[0]!;
  }

  private async storeResolveEvidence(
    task: ServerOwnedTask,
    pullRequest: PullRequestSnapshot,
    thread: ReviewThread,
    changed: boolean
  ): Promise<StoredGitHubEvidence> {
    return await storeGitHubEvidence(this.artifacts, "github-review-evidence", {
      semantic: "repo_write_pr_resolve_thread",
      repoId: task.repoId,
      taskId: task.taskId,
      pullRequestNumber: pullRequest.number,
      headSha: pullRequest.headSha,
      changed,
      thread: reviewThreadEvidence(thread),
      observedAt: this.clock.now().toISOString()
    });
  }

  private async assertResolutionEvidence(
    task: ServerOwnedTask,
    thread: ReviewThread,
    expectedHeadSha: string,
    expectedTreeSha: string
  ): Promise<void> {
    const [validation, operations] = await Promise.all([
      this.evidenceProvider.getValidationEvidence(task),
      this.ledger.listForTask({ repoId: task.repoId, taskId: task.taskId })
    ]);
    if (
      validation.status !== "passed"
      || validation.headSha !== expectedHeadSha
      || validation.treeSha !== expectedTreeSha
    ) {
      throw new GitHubBoundaryError("REVIEW_RESOLUTION_VALIDATION_MISSING", "Review resolution requires passed validation on the exact current head and tree.");
    }
    if (operations.some((operation) => operation.phase === "UNKNOWN_AFTER_CONTACT")) {
      throw new GitHubBoundaryError("UNKNOWN_EXTERNAL_EFFECT", "Review resolution is blocked by an unresolved unknown external effect.");
    }
    const snapshots = operations
      .filter((operation) => operation.semantic === "repo_pr_review_threads" && operation.phase === "EXTERNAL_SUCCEEDED")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const snapshotEvidence: Array<{
      operation: GitHubOperationRecord;
      value: { [key: string]: JsonValue };
    }> = [];
    for (const operation of snapshots) {
      const result = jsonRecord(operation.result);
      const digest = typeof result?.artifactDigest === "string" ? result.artifactDigest : undefined;
      if (!digest) continue;
      const value = await this.artifacts.getJson({ namespace: "github-review-evidence", digest });
      const snapshot = jsonRecord(value);
      if (!snapshot) continue;
      snapshotEvidence.push({ operation, value: snapshot });
      if (
        typeof snapshot.headSha === "string"
        && snapshot.headSha !== expectedHeadSha
        && Array.isArray(snapshot.threads)
        && snapshot.threads.some((entry) => jsonRecord(entry)?.id === thread.id)
      ) return;
    }

    const replies = operations
      .filter((operation) => operation.semantic === "repo_write_pr_reply" && operation.phase === "EXTERNAL_SUCCEEDED")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    let replyNeedsFreshValidation = false;
    for (const operation of replies) {
      const result = jsonRecord(operation.result);
      const digest = typeof result?.artifactDigest === "string" ? result.artifactDigest : undefined;
      if (!digest) continue;
      const replyValue = await this.artifacts.getJson({ namespace: "github-review-evidence", digest });
      const reply = jsonRecord(replyValue);
      const replyComment = jsonRecord(reply?.comment);
      if (
        !reply
        || !replyComment
        || reply.semantic !== "repo_write_pr_reply"
        || reply.repoId !== task.repoId
        || reply.taskId !== task.taskId
        || reply.pullRequestNumber !== thread.pullRequestNumber
        || reply.headSha !== expectedHeadSha
        || reply.threadId !== thread.id
        || result?.pullRequestNumber !== thread.pullRequestNumber
        || result.threadId !== thread.id
        || result.commentId !== replyComment.id
        || operation.subjectDigest !== sha256Json({ threadId: thread.id })
        || typeof replyComment.body !== "string"
        || operation.bindingDigest !== sha256Json({
          expectedHeadSha,
          expectedTreeSha,
          threadId: thread.id,
          bodyDigest: sha256(replyComment.body)
        })
        || !thread.comments.some((comment) => matchesReviewCommentEvidence(comment, replyComment))
      ) continue;

      const hasPriorSameHeadSnapshot = snapshotEvidence.some(({ operation: snapshotOperation, value: snapshot }) => (
        snapshotOperation.updatedAt.localeCompare(operation.createdAt) < 0
        && snapshot.semantic === "repo_pr_review_threads"
        && snapshot.repoId === task.repoId
        && snapshot.taskId === task.taskId
        && snapshot.pullRequestNumber === thread.pullRequestNumber
        && snapshot.headSha === expectedHeadSha
        && Array.isArray(snapshot.threads)
        && snapshot.threads.some((entry) => {
          const observedThread = jsonRecord(entry);
          return observedThread?.id === thread.id
            && observedThread.pullRequestId === thread.pullRequestId
            && observedThread.pullRequestNumber === thread.pullRequestNumber
            && observedThread.headSha === expectedHeadSha
            && observedThread.resolved === false
            && observedThread.outdated === false
            && Array.isArray(observedThread.comments)
            && !observedThread.comments.some((comment) => jsonRecord(comment)?.id === replyComment.id);
        })
      ));
      if (!hasPriorSameHeadSnapshot) continue;
      if (!validation.createdAt || validation.createdAt.localeCompare(operation.updatedAt) <= 0) {
        replyNeedsFreshValidation = true;
        continue;
      }
      return;
    }
    if (replyNeedsFreshValidation) {
      throw new GitHubBoundaryError(
        "REVIEW_CONFIRMATION_VALIDATION_STALE",
        "Same-head review confirmation requires fresh exact validation completed after the durable reply."
      );
    }
    throw new GitHubBoundaryError(
      "REVIEW_CORRECTION_EVIDENCE_MISSING",
      "Review resolution requires either a durable prior thread snapshot followed by a corrected head, or a durable same-head reply confirmed by fresh exact validation."
    );
  }
}

function jsonRecord(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function assertReviewPage(pullRequest: PullRequestSnapshot, page: {
  pullRequestId: string;
  pullRequestNumber: number;
  headSha: string;
  threads: ReviewThread[];
}): void {
  if (
    page.pullRequestId !== pullRequest.id
    || page.pullRequestNumber !== pullRequest.number
    || page.headSha !== pullRequest.headSha
  ) {
    throw new GitHubBoundaryError("REVIEW_HEAD_MISMATCH", "Review threads are not bound to the exact pull request head.");
  }
  for (const thread of page.threads) {
    if (
      thread.pullRequestId !== pullRequest.id
      || thread.pullRequestNumber !== pullRequest.number
      || thread.headSha !== pullRequest.headSha
    ) {
      throw new GitHubBoundaryError("REVIEW_THREAD_BINDING_MISMATCH", "A review thread is not bound to the exact pull request head.");
    }
  }
}

function assertResolvedThread(pullRequest: PullRequestSnapshot, threadId: string, thread: ReviewThread): void {
  if (
    thread.id !== threadId
    || thread.pullRequestId !== pullRequest.id
    || thread.pullRequestNumber !== pullRequest.number
    || thread.headSha !== pullRequest.headSha
    || !thread.isResolved
  ) {
    throw new GitHubBoundaryError("REVIEW_RESOLVE_READBACK_MISMATCH", "Resolved review thread does not match the exact request.", "UNKNOWN");
  }
}

function reviewThreadEvidence(thread: ReviewThread) {
  return {
    id: thread.id,
    pullRequestId: thread.pullRequestId,
    pullRequestNumber: thread.pullRequestNumber,
    headSha: thread.headSha,
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    path: thread.path,
    line: thread.line ?? null,
    originalLine: thread.originalLine ?? null,
    side: thread.side ?? null,
    comments: thread.comments.map(reviewCommentEvidence),
    updatedAt: thread.updatedAt
  } as const;
}

function reviewCommentEvidence(comment: ReviewComment) {
  return {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: comment.url
  } as const;
}

function matchesReviewCommentEvidence(
  comment: ReviewComment,
  evidence: { [key: string]: JsonValue }
): boolean {
  return evidence.id === comment.id
    && evidence.author === comment.author
    && evidence.body === comment.body
    && evidence.createdAt === comment.createdAt
    && evidence.updatedAt === comment.updatedAt
    && evidence.url === comment.url;
}

function resolveOperationResult(
  pullRequest: PullRequestSnapshot,
  thread: ReviewThread,
  changed: boolean,
  evidence: StoredGitHubEvidence
) {
  return {
    pullRequestNumber: pullRequest.number,
    threadId: thread.id,
    resolved: true,
    changed,
    updatedAt: thread.updatedAt,
    artifactId: evidence.artifactId,
    artifactDigest: evidence.digest
  } as const;
}

function assertCursor(value: string): string {
  if (value.length > 1_024 || value.includes("\0")) throw new GitHubBoundaryError("INVALID_CURSOR", "Review thread cursor is invalid.");
  return value;
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "REVIEW_OPERATION_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("REVIEW_OPERATION_FAILED", "Review operation failed without exposing external output.");
  return Object.assign(boundary, { operation });
}

function isOperationError(error: unknown): error is OperationBoundError {
  return error instanceof GitHubBoundaryError && "operation" in error;
}
