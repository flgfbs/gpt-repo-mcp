import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import { bindExactTask, type ExactTaskInput } from "../github/exact-task.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import type { OwnerApprovalVerifier } from "../github/owner-approval-store.js";
import {
  GitHubBoundaryError,
  assertSha,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type MergeApiResult,
  type MergeGateManifest,
  type PullRequestSnapshot,
  type ServerOwnedTask,
  type TaskLookup
} from "../github/types.js";
import type { ExactMergeGateVerifier } from "./github-merge-gate-service.js";
import { assertWritablePublicationTarget } from "./publication-target-guard.js";

export type MergeResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      manifestId: string;
      manifestSha256: string;
      approvalId: string;
      approvalConsumed: true;
      pullRequestNumber: number;
      mergeMethod: "merge" | "squash" | "rebase";
      mergedHeadSha: string;
      mergeCommitSha: string;
      mergedAt: string;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export class GitHubMergeService {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly gates: ExactMergeGateVerifier,
    private readonly approvals: OwnerApprovalVerifier,
    private readonly artifacts: ContentAddressedArtifactSink,
    ledger: DurableOperationLedger,
    clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async writeMerge(input: ExactTaskInput & {
    manifest_id: string;
    manifest_sha256: string;
    approval_id: string;
  }): Promise<MergeResult> {
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    if (task.repoId !== input.repo_id || task.taskId !== input.task_id) {
      throw new GitHubBoundaryError("TASK_ID_MISMATCH", "repo_id and task_id do not match the server-owned task.");
    }
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_write_merge",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { manifestId: input.manifest_id },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        manifestId: input.manifest_id,
        manifestSha256: input.manifest_sha256,
        approvalId: input.approval_id
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let manifest: MergeGateManifest;
    let pullRequest: PullRequestSnapshot;
    try {
      await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
      const approval = await this.approvals.inspect({
        approvalId: input.approval_id,
        gateId: input.manifest_id,
        gateSha256: input.manifest_sha256
      });
      if (approval.consumed) throw new GitHubBoundaryError("APPROVAL_CONSUMED", "Owner approval was already consumed.");
    } catch (error) {
      operation = await this.operations.transition(operation, "BLOCKED", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const repository = await this.github.getRepository(task.repository);
      assertWritablePublicationTarget(task, repository);
      manifest = await this.gates.loadAndRevalidateExactManifest({
        manifestId: input.manifest_id,
        manifestSha256: input.manifest_sha256
      });
      assertManifestTaskBinding(manifest, task, input);
      pullRequest = await this.github.getPullRequest(task.repository, manifest.pullRequestNumber);
      assertDraftMergeCandidate(manifest, pullRequest);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "LOCAL_MUTATION_STARTED");
    try {
      const claimed = await this.approvals.claim({
        approvalId: input.approval_id,
        gateId: input.manifest_id,
        gateSha256: input.manifest_sha256,
        operationId: input.operation_id
      });
      if (!claimed.consumed || claimed.consumedByOperationId !== input.operation_id) {
        throw new GitHubBoundaryError("APPROVAL_CLAIM_MISMATCH", "Owner approval claim does not match this exact merge operation.");
      }
      operation = await this.operations.transition(operation, "LOCAL_MUTATION_COMPLETE", {
        result: {
          approvalId: input.approval_id,
          approvalConsumed: true,
          manifestId: input.manifest_id,
          manifestSha256: input.manifest_sha256
        }
      });
    } catch (error) {
      operation = await this.operations.transition(operation, "BLOCKED", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    let readyObserved = false;
    let mergeApiResult: MergeApiResult | undefined;
    try {
      const ready = await this.github.markPullRequestReady(task.repository, manifest.pullRequestId);
      assertReadyMergeCandidate(manifest, ready);
      readyObserved = true;
      mergeApiResult = await this.github.mergePullRequest({
        repository: task.repository,
        number: manifest.pullRequestNumber,
        expectedHeadSha: manifest.headSha,
        method: manifest.mergeMethod
      });
      if (!mergeApiResult.merged) {
        throw new GitHubBoundaryError("MERGE_NOT_CONFIRMED", "GitHub did not confirm the exact merge.", "UNKNOWN");
      }
      const merged = await this.github.getPullRequest(task.repository, manifest.pullRequestNumber);
      return await this.completeKnownMerge(operation, task, manifest, input.approval_id, merged, mergeApiResult, false);
    } catch (error) {
      if (isOperationError(error)) throw error;
      try {
        const observed = await this.github.getPullRequest(task.repository, manifest.pullRequestNumber);
        if (isExactMergedPullRequest(manifest, observed)) {
          return await this.completeKnownMerge(operation, task, manifest, input.approval_id, observed, mergeApiResult, true);
        }
        const partial = readyObserved || (observed.state === "OPEN" && !observed.isDraft);
        operation = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
          result: {
            approvalId: input.approval_id,
            approvalConsumed: true,
            manifestId: manifest.manifestId,
            pullRequestNumber: manifest.pullRequestNumber,
            readyObserved: partial,
            mergedObserved: false
          },
          failureCode: partial ? "MERGE_PARTIAL_READY_ONLY" : errorCode(error)
        });
        throw operationError(
          new GitHubBoundaryError(
            partial ? "MERGE_PARTIAL_READY_ONLY" : "MERGE_EFFECT_UNKNOWN",
            partial
              ? "Pull request was marked Ready but the exact merge was not confirmed; replay is prohibited."
              : "Merge effect is not safely replayable.",
            "UNKNOWN"
          ),
          operation
        );
      } catch (readbackError) {
        if (isOperationError(readbackError)) throw readbackError;
        operation = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
          result: {
            approvalId: input.approval_id,
            approvalConsumed: true,
            manifestId: manifest.manifestId,
            pullRequestNumber: manifest.pullRequestNumber,
            readyObserved
          },
          failureCode: "MERGE_READBACK_UNAVAILABLE"
        });
        throw operationError(error, operation);
      }
    }
  }

  private async completeKnownMerge(
    operation: GitHubOperationRecord,
    task: ServerOwnedTask,
    manifest: MergeGateManifest,
    approvalId: string,
    pullRequest: PullRequestSnapshot,
    apiResult: MergeApiResult | undefined,
    reconciled: boolean
  ): Promise<MergeResult> {
    assertMergedPullRequest(manifest, pullRequest);
    const mergeCommitSha = assertSha(pullRequest.mergeCommitSha ?? apiResult?.sha ?? "", "merge commit sha");
    if (!pullRequest.mergedAt) throw new GitHubBoundaryError("MERGE_TIMESTAMP_MISSING", "Merged pull request lacks an authoritative merged timestamp.", "UNKNOWN");
    const resultValue = {
      manifestId: manifest.manifestId,
      manifestSha256: manifest.manifestSha256,
      approvalId,
      approvalConsumed: true,
      pullRequestNumber: manifest.pullRequestNumber,
      mergeMethod: manifest.mergeMethod,
      baseSha: manifest.baseSha,
      mergedHeadSha: manifest.headSha,
      mergeCommitSha,
      mergedAt: pullRequest.mergedAt,
      retainTaskBranch: true,
      reconciled
    } as const;
    let evidence: StoredGitHubEvidence;
    try {
      evidence = await storeGitHubEvidence(this.artifacts, "github-merge-evidence", {
        semantic: "repo_write_merge",
        repoId: task.repoId,
        taskId: task.taskId,
        ...resultValue
      });
    } catch (error) {
      const failed = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
        result: resultValue,
        failureCode: "MERGE_EVIDENCE_STORE_FAILED"
      });
      throw operationError(error, failed);
    }
    const completed = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
      result: { ...resultValue, artifactId: evidence.artifactId, artifactDigest: evidence.digest }
    });
    return {
      disposition: "EXECUTED",
      operation: completed,
      manifestId: manifest.manifestId,
      manifestSha256: manifest.manifestSha256,
      approvalId,
      approvalConsumed: true,
      pullRequestNumber: manifest.pullRequestNumber,
      mergeMethod: manifest.mergeMethod,
      mergedHeadSha: manifest.headSha,
      mergeCommitSha,
      mergedAt: pullRequest.mergedAt,
      evidence
    };
  }
}

function assertManifestTaskBinding(manifest: MergeGateManifest, task: ServerOwnedTask, input: ExactTaskInput): void {
  if (
    manifest.repoId !== task.repoId
    || manifest.taskId !== task.taskId
    || manifest.repositoryNameWithOwner.toLowerCase() !== `${task.repository.owner}/${task.repository.name}`.toLowerCase()
    || manifest.taskBranch !== task.branch
    || manifest.baseBranch !== task.baseBranch
    || manifest.headSha !== input.expected_head_sha
    || manifest.treeSha !== input.expected_tree_sha
    || manifest.mergeMethod !== task.mergeMethod
    || manifest.deleteTaskBranch !== false
    || manifest.retainTaskBranch !== true
  ) {
    throw new GitHubBoundaryError("MERGE_MANIFEST_BINDING_MISMATCH", "Merge manifest does not match the exact server-owned task.");
  }
}

function assertDraftMergeCandidate(manifest: MergeGateManifest, pullRequest: PullRequestSnapshot): void {
  if (
    pullRequest.id !== manifest.pullRequestId
    || pullRequest.number !== manifest.pullRequestNumber
    || pullRequest.state !== "OPEN"
    || !pullRequest.isDraft
    || pullRequest.mergeable !== "MERGEABLE"
    || pullRequest.headRefName !== manifest.taskBranch
    || pullRequest.headSha !== manifest.headSha
    || pullRequest.baseRefName !== manifest.baseBranch
    || pullRequest.baseSha !== manifest.baseSha
  ) {
    throw new GitHubBoundaryError("MERGE_PR_DRIFT", "Pull request is no longer the exact OPEN Draft MERGEABLE gate candidate.");
  }
}

function assertReadyMergeCandidate(manifest: MergeGateManifest, pullRequest: PullRequestSnapshot): void {
  if (
    pullRequest.id !== manifest.pullRequestId
    || pullRequest.number !== manifest.pullRequestNumber
    || pullRequest.state !== "OPEN"
    || pullRequest.isDraft
    || pullRequest.headRefName !== manifest.taskBranch
    || pullRequest.headSha !== manifest.headSha
    || pullRequest.baseRefName !== manifest.baseBranch
  ) {
    throw new GitHubBoundaryError("READY_READBACK_MISMATCH", "Marked-Ready pull request does not match the exact approved head.", "UNKNOWN");
  }
}

function isExactMergedPullRequest(manifest: MergeGateManifest, pullRequest: PullRequestSnapshot): boolean {
  return pullRequest.number === manifest.pullRequestNumber
    && pullRequest.state === "MERGED"
    && pullRequest.headRefName === manifest.taskBranch
    && pullRequest.headSha === manifest.headSha
    && pullRequest.baseRefName === manifest.baseBranch
    && pullRequest.mergeCommitSha !== undefined
    && pullRequest.mergedAt !== undefined;
}

function assertMergedPullRequest(manifest: MergeGateManifest, pullRequest: PullRequestSnapshot): void {
  if (!isExactMergedPullRequest(manifest, pullRequest)) {
    throw new GitHubBoundaryError("MERGE_READBACK_MISMATCH", "Merged pull request does not match the exact approved head.", "UNKNOWN");
  }
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "MERGE_OPERATION_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("MERGE_OPERATION_FAILED", "Merge operation failed without exposing external output.");
  return Object.assign(boundary, { operation });
}

function isOperationError(error: unknown): error is OperationBoundError {
  return error instanceof GitHubBoundaryError && "operation" in error;
}
