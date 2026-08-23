import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import { bindExactTask, type ExactTaskInput } from "../github/exact-task.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import {
  GitHubBoundaryError,
  assertSafeIdentifier,
  assertSha,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type JsonValue,
  type TaskLookup
} from "../github/types.js";

export type PostMergeReadbackResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      mergeOperationId: string;
      pullRequestNumber: number;
      mergedHeadSha: string;
      mergeCommitSha: string;
      baseHeadSha?: string;
      taskBranchHeadSha?: string;
      taskBranchRetained: boolean;
      baseContainsMergeCommit: boolean;
      readbackState: "confirmed" | "incomplete";
      observedAt: string;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

type StoredMergeResult = {
  pullRequestNumber: number;
  mergedHeadSha: string;
  mergeCommitSha: string;
  mergedAt: string;
  mergeMethod: "merge" | "squash" | "rebase";
};

export class GitHubPostMergeService {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly artifacts: ContentAddressedArtifactSink,
    private readonly ledger: DurableOperationLedger,
    private readonly clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async postMergeReadback(input: ExactTaskInput & { merge_operation_id: string }): Promise<PostMergeReadbackResult> {
    assertSafeIdentifier(input.merge_operation_id, "merge operation id");
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    if (task.repoId !== input.repo_id || task.taskId !== input.task_id) {
      throw new GitHubBoundaryError("TASK_ID_MISMATCH", "repo_id and task_id do not match the server-owned task.");
    }
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_post_merge_readback",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { mergeOperationId: input.merge_operation_id },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        mergeOperationId: input.merge_operation_id,
        retainTaskBranch: true
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let merge: StoredMergeResult;
    try {
      await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: false });
      const records = await this.ledger.listForTask({ repoId: task.repoId, taskId: task.taskId });
      const matches = records.filter((record) => record.operationId === input.merge_operation_id);
      if (matches.length !== 1) throw new GitHubBoundaryError("MERGE_OPERATION_NOT_FOUND", "Exact merge operation is unavailable.");
      const record = matches[0]!;
      if (record.semantic !== "repo_write_merge" || record.phase !== "EXTERNAL_SUCCEEDED") {
        throw new GitHubBoundaryError("MERGE_OPERATION_NOT_COMPLETE", "Exact merge operation is not durably successful.");
      }
      merge = parseStoredMergeResult(record.result);
      if (merge.mergedHeadSha !== input.expected_head_sha) {
        throw new GitHubBoundaryError("MERGE_OPERATION_HEAD_MISMATCH", "Merge operation is not bound to expected_head_sha.");
      }
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_PRECONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const [pullRequest, baseRef, taskRef] = await Promise.all([
        this.github.getPullRequest(task.repository, merge.pullRequestNumber),
        this.github.getRef(task.repository, `refs/heads/${task.baseBranch}`),
        this.github.getRef(task.repository, `refs/heads/${task.branch}`)
      ]);
      const pullRequestConfirmed = pullRequest.state === "MERGED"
        && pullRequest.number === merge.pullRequestNumber
        && pullRequest.headSha === merge.mergedHeadSha
        && pullRequest.mergeCommitSha === merge.mergeCommitSha;
      let baseContainsMergeCommit = false;
      if (baseRef) {
        const comparison = await this.github.compare(task.repository, merge.mergeCommitSha, baseRef.sha);
        baseContainsMergeCommit = comparison.status === "ahead" || comparison.status === "identical";
      }
      const taskBranchRetained = taskRef?.sha === merge.mergedHeadSha;
      const readbackState = pullRequestConfirmed && baseContainsMergeCommit && taskBranchRetained
        ? "confirmed"
        : "incomplete";
      const observedAt = this.clock.now().toISOString();
      const evidence = await storeGitHubEvidence(this.artifacts, "github-post-merge-evidence", {
        semantic: "repo_post_merge_readback",
        repoId: task.repoId,
        taskId: task.taskId,
        mergeOperationId: input.merge_operation_id,
        pullRequestNumber: merge.pullRequestNumber,
        mergeMethod: merge.mergeMethod,
        mergedHeadSha: merge.mergedHeadSha,
        mergeCommitSha: merge.mergeCommitSha,
        pullRequestConfirmed,
        baseHeadSha: baseRef?.sha ?? null,
        taskBranchHeadSha: taskRef?.sha ?? null,
        baseContainsMergeCommit,
        taskBranchRetained,
        readbackState,
        observedAt
      });
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          mergeOperationId: input.merge_operation_id,
          pullRequestNumber: merge.pullRequestNumber,
          mergedHeadSha: merge.mergedHeadSha,
          mergeCommitSha: merge.mergeCommitSha,
          baseHeadSha: baseRef?.sha ?? null,
          taskBranchHeadSha: taskRef?.sha ?? null,
          baseContainsMergeCommit,
          taskBranchRetained,
          readbackState,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest,
          observedAt
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        mergeOperationId: input.merge_operation_id,
        pullRequestNumber: merge.pullRequestNumber,
        mergedHeadSha: merge.mergedHeadSha,
        mergeCommitSha: merge.mergeCommitSha,
        ...(baseRef ? { baseHeadSha: baseRef.sha } : {}),
        ...(taskRef ? { taskBranchHeadSha: taskRef.sha } : {}),
        taskBranchRetained,
        baseContainsMergeCommit,
        readbackState,
        observedAt,
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
  }
}

function parseStoredMergeResult(value: JsonValue | undefined): StoredMergeResult {
  if (!isRecord(value)) throw new GitHubBoundaryError("MERGE_RECEIPT_INVALID", "Stored merge receipt is unavailable.");
  if (
    typeof value.pullRequestNumber !== "number"
    || !Number.isSafeInteger(value.pullRequestNumber)
    || value.pullRequestNumber <= 0
    || typeof value.mergedHeadSha !== "string"
    || typeof value.mergeCommitSha !== "string"
    || typeof value.mergedAt !== "string"
    || (value.mergeMethod !== "merge" && value.mergeMethod !== "squash" && value.mergeMethod !== "rebase")
  ) {
    throw new GitHubBoundaryError("MERGE_RECEIPT_INVALID", "Stored merge receipt has an invalid fixed schema.");
  }
  return {
    pullRequestNumber: value.pullRequestNumber,
    mergedHeadSha: assertSha(value.mergedHeadSha, "stored merged head sha"),
    mergeCommitSha: assertSha(value.mergeCommitSha, "stored merge commit sha"),
    mergedAt: value.mergedAt,
    mergeMethod: value.mergeMethod
  };
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "POST_MERGE_READBACK_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("POST_MERGE_READBACK_FAILED", "Post-merge readback failed without exposing external output.");
  return Object.assign(boundary, { operation });
}
