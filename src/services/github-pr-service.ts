import { GitHubOperationController } from "../github/operation-controller.js";
import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import {
  GitHubBoundaryError,
  assertSafeExternalText,
  assertSha,
  sha256,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type LocalGitSnapshot,
  type PullRequestSnapshot,
  type ServerOwnedTask,
  type TaskLookup
} from "../github/types.js";

export type ExactTaskStateInput = {
  operation_id: string;
  repo_id: string;
  task_id: string;
  expected_head_sha: string;
  expected_tree_sha: string;
};

export type PrCreateOrUpdateResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      action: "created" | "updated" | "no_change";
      pullRequest: PullRequestSnapshot;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export type PrStatusResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      ok: true;
      semantic: "repo_pr_status";
      operation_id: string;
      repo_id: string;
      task_id: string;
      pullRequest?: PullRequestSnapshot;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export class GitHubPrService {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly artifacts: ContentAddressedArtifactSink,
    ledger: DurableOperationLedger,
    clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async prStatus(input: ExactTaskStateInput): Promise<PrStatusResult> {
    const { task } = await this.bindExactTask(input, false);
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_pr_status",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch, baseBranch: task.baseBranch },
      binding: { expectedHeadSha: input.expected_head_sha, expectedTreeSha: input.expected_tree_sha }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      await this.assertRemoteHead(task, input.expected_head_sha, input.expected_tree_sha);
      const matches = await this.github.findOpenPullRequests({
        repository: task.repository,
        headBranch: task.branch,
        baseBranch: task.baseBranch
      });
      if (matches.length > 1) throw new GitHubBoundaryError("PR_AMBIGUOUS", "Multiple open pull requests match the task branch.");
      const pullRequest = matches[0];
      if (pullRequest) assertExactPullRequest(task, pullRequest, input.expected_head_sha, false);
      const evidence = await this.storePrEvidence(task, pullRequest, "repo_pr_status");
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          pullRequestNumber: pullRequest?.number ?? null,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        ok: true,
        semantic: "repo_pr_status",
        operation_id: input.operation_id,
        repo_id: task.repoId,
        task_id: task.taskId,
        ...(pullRequest ? { pullRequest } : {}),
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw bindOperationError(error, operation);
    }
  }

  async prCreateOrUpdate(input: ExactTaskStateInput & {
    title: string;
    body: string;
    draft: true;
  }): Promise<PrCreateOrUpdateResult> {
    if (input.draft !== true) throw new GitHubBoundaryError("DRAFT_REQUIRED", "Pull request create-or-update requires draft=true.");
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    assertTaskId(task, input.task_id);
    const title = assertSafeExternalText(input.title, "pull request title", [task.root]);
    const marker = `<!-- chat-pro-operation:${input.operation_id} -->`;
    const bodyText = input.body.length === 0 ? marker : `${assertSafeExternalText(input.body, "pull request body", [task.root])}\n\n${marker}`;
    if (bodyText.length > 65_536) throw new GitHubBoundaryError("PR_BODY_TOO_LARGE", "Pull request body exceeds the fixed limit.");
    const expectedHeadSha = assertSha(input.expected_head_sha, "expected pull request head sha");
    const expectedTreeSha = assertSha(input.expected_tree_sha, "expected pull request tree sha");
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_pr_create_or_update",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch, baseBranch: task.baseBranch },
      binding: {
        expectedHeadSha,
        expectedTreeSha,
        titleDigest: sha256(title),
        bodyDigest: sha256(bodyText),
        draft: true
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;

    let existing: PullRequestSnapshot | undefined;
    try {
      await this.bindExactTask(input, true);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_PRECONTACT", { failureCode: errorCode(error) });
      throw bindOperationError(error, operation);
    }
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      await this.assertRemoteHead(task, expectedHeadSha, expectedTreeSha);
      const matches = await this.github.findOpenPullRequests({
        repository: task.repository,
        headBranch: task.branch,
        baseBranch: task.baseBranch
      });
      if (matches.length > 1) throw new GitHubBoundaryError("PR_AMBIGUOUS", "Multiple open pull requests match the task branch.");
      existing = matches[0];
      if (existing) assertExactPullRequest(task, existing, expectedHeadSha, true);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw bindOperationError(error, operation);
    }

    if (existing && existing.titleDigest === sha256(title) && existing.bodyDigest === sha256(bodyText)) {
      try {
        const evidence = await this.storePrEvidence(task, existing, "repo_pr_create_or_update");
        operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
          result: { ...operationResult("no_change", existing), artifactId: evidence.artifactId, artifactDigest: evidence.digest }
        });
        return { disposition: "EXECUTED", operation, action: "no_change", pullRequest: existing, evidence };
      } catch (error) {
        operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
        throw bindOperationError(error, operation);
      }
    }

    const action = existing ? "updated" : "created";
    let changed: PullRequestSnapshot;
    try {
      changed = existing
        ? await this.github.updatePullRequest({
            repository: task.repository,
            number: existing.number,
            title,
            body: bodyText,
            baseBranch: task.baseBranch
          })
        : await this.github.createDraftPullRequest({
            repository: task.repository,
            title,
            body: bodyText,
            headBranch: task.branch,
            baseBranch: task.baseBranch
          });
      assertDesiredDraft(task, changed, expectedHeadSha, input.operation_id, title, bodyText);
    } catch {
      return await this.reconcileUnknownPrWrite(task, operation, expectedHeadSha, input.operation_id, title, bodyText, action);
    }
    try {
      const evidence = await this.storePrEvidence(task, changed, "repo_pr_create_or_update");
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: { ...operationResult(action, changed), artifactId: evidence.artifactId, artifactDigest: evidence.digest }
      });
      return { disposition: "EXECUTED", operation, action, pullRequest: changed, evidence };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
        result: operationResult(action, changed),
        failureCode: "PR_EVIDENCE_STORE_FAILED"
      });
      throw bindOperationError(error, operation);
    }
  }

  private async bindExactTask(input: ExactTaskStateInput, requireClean: boolean): Promise<{
    task: ServerOwnedTask;
    local: LocalGitSnapshot;
  }> {
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    assertTaskId(task, input.task_id);
    const local = await this.git.inspect(task);
    if (local.branch !== task.branch) throw new GitHubBoundaryError("TASK_BRANCH_DRIFT", "Current branch is not the server-owned task branch.");
    if (local.headSha !== assertSha(input.expected_head_sha, "expected head sha")) throw new GitHubBoundaryError("HEAD_DRIFT", "Task HEAD no longer matches expected_head_sha.");
    if (local.treeSha !== assertSha(input.expected_tree_sha, "expected tree sha")) throw new GitHubBoundaryError("TREE_DRIFT", "Task tree no longer matches expected_tree_sha.");
    if (requireClean && !local.clean) throw new GitHubBoundaryError("WORKTREE_NOT_CLEAN", "Task worktree must be clean before external mutation.");
    return { task, local };
  }

  private async assertRemoteHead(task: ServerOwnedTask, expectedHeadSha: string, expectedTreeSha: string): Promise<void> {
    const remote = await this.github.getRef(task.repository, `refs/heads/${task.branch}`);
    if (remote?.sha !== expectedHeadSha || remote.treeSha !== expectedTreeSha) {
      throw new GitHubBoundaryError("REMOTE_HEAD_MISMATCH", "Remote task branch does not match the exact expected head and tree.");
    }
  }

  private async reconcileUnknownPrWrite(
    task: ServerOwnedTask,
    operation: GitHubOperationRecord,
    expectedHeadSha: string,
    operationId: string,
    title: string,
    body: string,
    action: "created" | "updated"
  ): Promise<PrCreateOrUpdateResult> {
    let exact: PullRequestSnapshot[];
    try {
      const matches = await this.github.findOpenPullRequests({
        repository: task.repository,
        headBranch: task.branch,
        baseBranch: task.baseBranch
      });
      exact = matches.filter((candidate) => {
        try {
          assertDesiredDraft(task, candidate, expectedHeadSha, operationId, title, body);
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      exact = [];
    }
    if (exact.length === 1) {
      try {
        const evidence = await this.storePrEvidence(task, exact[0]!, "repo_pr_create_or_update");
        const complete = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
          result: {
            ...operationResult(action, exact[0]!),
            reconciled: true,
            artifactId: evidence.artifactId,
            artifactDigest: evidence.digest
          }
        });
        return { disposition: "EXECUTED", operation: complete, action, pullRequest: exact[0]!, evidence };
      } catch (error) {
        const failed = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", {
          result: { ...operationResult(action, exact[0]!), reconciled: true },
          failureCode: "PR_EVIDENCE_STORE_FAILED"
        });
        throw bindOperationError(error, failed);
      }
    }
    const unknown = await this.operations.transition(operation, "UNKNOWN_AFTER_CONTACT", {
      failureCode: "PR_WRITE_EFFECT_UNKNOWN"
    });
    throw bindOperationError(new GitHubBoundaryError("PR_WRITE_EFFECT_UNKNOWN", "Pull request write effect is not safely replayable.", "UNKNOWN"), unknown);
  }

  private async storePrEvidence(
    task: ServerOwnedTask,
    pullRequest: PullRequestSnapshot | undefined,
    semantic: "repo_pr_status" | "repo_pr_create_or_update"
  ): Promise<StoredGitHubEvidence> {
    return await storeGitHubEvidence(this.artifacts, "github-pr-evidence", {
      semantic,
      repoId: task.repoId,
      taskId: task.taskId,
      branch: task.branch,
      pullRequest: pullRequest ? {
        id: pullRequest.id,
        number: pullRequest.number,
        url: pullRequest.url,
        state: pullRequest.state,
        draft: pullRequest.isDraft,
        title: pullRequest.title,
        headBranch: pullRequest.headRefName,
        headSha: pullRequest.headSha,
        baseBranch: pullRequest.baseRefName,
        baseSha: pullRequest.baseSha,
        mergeable: pullRequest.mergeable,
        titleDigest: pullRequest.titleDigest,
        bodyDigest: pullRequest.bodyDigest,
        updatedAt: pullRequest.updatedAt
      } : null
    });
  }
}

function assertTaskId(task: ServerOwnedTask, taskId: string): void {
  if (task.taskId !== taskId) throw new GitHubBoundaryError("TASK_ID_MISMATCH", "task_id does not match the server-owned task.");
}

function assertExactPullRequest(task: ServerOwnedTask, pr: PullRequestSnapshot, expectedHeadSha: string, requireDraft: boolean): void {
  if (pr.state !== "OPEN") throw new GitHubBoundaryError("PR_NOT_OPEN", "Task pull request is not open.");
  if (requireDraft && !pr.isDraft) throw new GitHubBoundaryError("PR_NOT_DRAFT", "Pull request create-or-update is admitted only while Draft.");
  if (pr.headRefName !== task.branch || pr.headSha !== expectedHeadSha) throw new GitHubBoundaryError("PR_HEAD_MISMATCH", "Pull request head does not match the exact task branch.");
  if (pr.baseRefName !== task.baseBranch) throw new GitHubBoundaryError("PR_BASE_MISMATCH", "Pull request base does not match the task binding.");
}

function assertDesiredDraft(
  task: ServerOwnedTask,
  pr: PullRequestSnapshot,
  expectedHeadSha: string,
  operationId: string,
  title: string,
  body: string
): void {
  assertExactPullRequest(task, pr, expectedHeadSha, true);
  if (!pr.operationMarkers.includes(operationId)) throw new GitHubBoundaryError("PR_OPERATION_MARKER_MISSING", "Pull request does not contain the exact operation marker.", "UNKNOWN");
  if (pr.titleDigest !== sha256(title) || pr.bodyDigest !== sha256(body)) {
    throw new GitHubBoundaryError("PR_CONTENT_MISMATCH", "Pull request content readback does not match the exact write.", "UNKNOWN");
  }
}

function operationResult(action: "created" | "updated" | "no_change", pr: PullRequestSnapshot) {
  return {
    action,
    pullRequestNumber: pr.number,
    headSha: pr.headSha,
    draft: pr.isDraft,
    titleDigest: pr.titleDigest,
    bodyDigest: pr.bodyDigest
  } as const;
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "PR_OPERATION_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function bindOperationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("PR_OPERATION_FAILED", "Pull request operation failed.");
  return Object.assign(boundary, { operation });
}
