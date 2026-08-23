import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import {
  bindExactTask,
  getUniqueTaskPullRequest,
  listAllExactReviewThreads,
  type ExactTaskInput
} from "../github/exact-task.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import {
  GitHubBoundaryError,
  assertSafeBranch,
  assertSafeIdentifier,
  assertSha,
  repositorySlug,
  sha256Json,
  type Clock,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactCiEvidenceReader,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type JsonValue,
  type MergeEvidenceProvider,
  type MergeGateManifest,
  type MergeGateManifestCore,
  type PullRequestSnapshot,
  type ServerOwnedTask,
  type TaskLookup
} from "../github/types.js";

export type MergeGateBlocker = { code: string; message: string };

export type MergeGatePrepareResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      eligible: true;
      blockers: [];
      manifest: MergeGateManifest;
      ownerCommand: string;
      evidence: StoredGitHubEvidence;
    }
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      eligible: false;
      blockers: MergeGateBlocker[];
      manifest: null;
      ownerCommand: null;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export interface ExactMergeGateVerifier {
  loadAndRevalidateExactManifest(input: {
    manifestId: string;
    manifestSha256: string;
  }): Promise<MergeGateManifest>;
}

type GateEvaluation = {
  blockers: MergeGateBlocker[];
  core: MergeGateManifestCore;
};

export class GitHubMergeGateService implements ExactMergeGateVerifier {
  private readonly operations: GitHubOperationController;

  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly ci: ExactCiEvidenceReader,
    private readonly evidenceProvider: MergeEvidenceProvider,
    private readonly artifacts: ContentAddressedArtifactSink,
    private readonly ledger: DurableOperationLedger,
    private readonly clock: Clock,
    private readonly manifestTtlMs = 15 * 60 * 1000
  ) {
    if (!Number.isSafeInteger(manifestTtlMs) || manifestTtlMs < 60_000 || manifestTtlMs > 60 * 60 * 1000) {
      throw new GitHubBoundaryError("INVALID_GATE_TTL", "Merge gate TTL must be between one minute and one hour.");
    }
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async mergeGatePrepare(input: ExactTaskInput): Promise<MergeGatePrepareResult> {
    const task = await this.tasks.getServerOwnedTask(input.repo_id);
    if (task.repoId !== input.repo_id || task.taskId !== input.task_id) {
      throw new GitHubBoundaryError("TASK_ID_MISMATCH", "repo_id and task_id do not match the server-owned task.");
    }
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_merge_gate_prepare",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { branch: task.branch, baseBranch: task.baseBranch },
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        mergeMethod: task.mergeMethod,
        retainTaskBranch: true
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    let evaluation: GateEvaluation;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      evaluation = await this.evaluate(task, input.expected_head_sha, input.expected_tree_sha);
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "LOCAL_MUTATION_STARTED");
    if (evaluation.blockers.length > 0) {
      try {
        const evidence = await storeGitHubEvidence(this.artifacts, "github-merge-gates", {
          semantic: "repo_merge_gate_prepare",
          eligible: false,
          repoId: task.repoId,
          taskId: task.taskId,
          headSha: input.expected_head_sha,
          treeSha: input.expected_tree_sha,
          blockers: evaluation.blockers,
          observedAt: this.clock.now().toISOString()
        });
        operation = await this.operations.transition(operation, "LOCAL_MUTATION_COMPLETE");
        operation = await this.operations.transition(operation, "BLOCKED", {
          result: {
            eligible: false,
            blockers: evaluation.blockers,
            artifactId: evidence.artifactId,
            artifactDigest: evidence.digest
          }
        });
        return {
          disposition: "EXECUTED",
          operation,
          eligible: false,
          blockers: evaluation.blockers,
          manifest: null,
          ownerCommand: null,
          evidence
        };
      } catch (error) {
        if (operation.phase !== "LOCAL_MUTATION_STARTED") throw error;
        operation = await this.operations.transition(operation, "BLOCKED", { failureCode: errorCode(error) });
        throw operationError(error, operation);
      }
    }

    try {
      const manifestSha256 = sha256Json(manifestCoreJson(evaluation.core));
      const manifestId = `merge_manifest_${manifestSha256}`;
      const stored = await this.artifacts.putJson({
        namespace: "github-merge-gates",
        digest: manifestSha256,
        value: manifestCoreJson(evaluation.core),
        mode: 0o600
      });
      const evidence = { artifactId: stored.artifactId, digest: manifestSha256 };
      const manifest: MergeGateManifest = {
        ...evaluation.core,
        manifestId,
        manifestSha256,
        artifactId: stored.artifactId
      };
      operation = await this.operations.transition(operation, "LOCAL_MUTATION_COMPLETE");
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          eligible: true,
          manifestId,
          manifestSha256,
          artifactId: stored.artifactId,
          ownerCommand: ownerCommand(manifestId)
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        eligible: true,
        blockers: [],
        manifest,
        ownerCommand: ownerCommand(manifestId),
        evidence
      };
    } catch (error) {
      if (operation.phase === "LOCAL_MUTATION_STARTED") {
        operation = await this.operations.transition(operation, "BLOCKED", { failureCode: errorCode(error) });
      }
      throw operationError(error, operation);
    }
  }

  async loadAndRevalidateExactManifest(input: {
    manifestId: string;
    manifestSha256: string;
  }): Promise<MergeGateManifest> {
    const manifestSha256 = assertDigest(input.manifestSha256, "manifest_sha256");
    if (input.manifestId !== `merge_manifest_${manifestSha256}`) {
      throw new GitHubBoundaryError("MERGE_MANIFEST_ID_MISMATCH", "Manifest id is not bound to the exact manifest digest.");
    }
    const stored = await this.artifacts.getJson({ namespace: "github-merge-gates", digest: manifestSha256 });
    if (stored === undefined || sha256Json(stored) !== manifestSha256) {
      throw new GitHubBoundaryError("MERGE_MANIFEST_NOT_FOUND", "The exact content-addressed merge manifest is unavailable.");
    }
    const core = parseMergeGateManifestCore(stored);
    if (Date.parse(core.expiresAt) <= this.clock.now().getTime()) {
      throw new GitHubBoundaryError("MERGE_MANIFEST_EXPIRED", "Merge manifest approval window has expired.");
    }
    const task = await this.tasks.getServerOwnedTask(core.repoId);
    if (task.taskId !== core.taskId) throw new GitHubBoundaryError("MERGE_MANIFEST_TASK_MISMATCH", "Merge manifest task binding is no longer current.");
    const current = await this.evaluate(task, core.headSha, core.treeSha, {
      ciStatusId: core.ciStatusId,
      preparedAt: core.preparedAt,
      expiresAt: core.expiresAt
    });
    if (current.blockers.length > 0 || sha256Json(manifestCoreJson(current.core)) !== manifestSha256) {
      throw new GitHubBoundaryError("MERGE_GATE_DRIFT", "Exact merge gate no longer matches its approved manifest.");
    }
    return {
      ...core,
      manifestId: input.manifestId,
      manifestSha256
    };
  }

  private async evaluate(
    task: ServerOwnedTask,
    expectedHeadSha: string,
    expectedTreeSha: string,
    fixed?: { ciStatusId: string; preparedAt: string; expiresAt: string }
  ): Promise<GateEvaluation> {
    await bindExactTask({
      tasks: this.tasks,
      git: this.git,
      request: {
        operation_id: "gate-evaluation",
        repo_id: task.repoId,
        task_id: task.taskId,
        expected_head_sha: expectedHeadSha,
        expected_tree_sha: expectedTreeSha
      },
      requireClean: true
    });
    const [repository, taskRef, baseRef, ci, validation, independentReview, operations] = await Promise.all([
      this.github.getRepository(task.repository),
      this.github.getRef(task.repository, `refs/heads/${task.branch}`),
      this.github.getRef(task.repository, `refs/heads/${task.baseBranch}`),
      this.ci.getExactCiEvidence(task, expectedHeadSha),
      this.evidenceProvider.getValidationEvidence(task),
      this.evidenceProvider.getIndependentReviewEvidence(task),
      this.ledger.listForTask({ repoId: task.repoId, taskId: task.taskId })
    ]);
    const blockers: MergeGateBlocker[] = [];
    if (repository.id.length === 0 || repository.nameWithOwner.toLowerCase() !== repositorySlug(task.repository).toLowerCase()) {
      blockers.push(blocker("REPOSITORY_IDENTITY_MISMATCH", "Repository identity does not match the task binding."));
    }
    if (repository.archived) blockers.push(blocker("REPOSITORY_ARCHIVED", "Archived repositories cannot be merged."));
    if (repository.defaultBranch !== task.baseBranch) blockers.push(blocker("DEFAULT_BRANCH_DRIFT", "Repository default branch differs from the task base branch."));
    if (!repository.mergeMethods[task.mergeMethod]) blockers.push(blocker("MERGE_METHOD_UNAVAILABLE", "Configured repository merge method is unavailable."));
    if (!["WRITE", "MAINTAIN", "ADMIN"].includes(repository.viewerPermission.toUpperCase())) {
      blockers.push(blocker("MERGE_PERMISSION_UNAVAILABLE", "Current inherited GitHub identity lacks write permission."));
    }
    if (taskRef?.sha !== expectedHeadSha || taskRef.treeSha !== expectedTreeSha) {
      blockers.push(blocker("REMOTE_HEAD_MISMATCH", "Remote task branch differs from the exact task head and tree."));
    }
    if (!baseRef) blockers.push(blocker("BASE_REF_MISSING", "Bound base branch is missing remotely."));

    let pullRequest: PullRequestSnapshot | undefined;
    try {
      pullRequest = await getUniqueTaskPullRequest({ github: this.github, task, expectedHeadSha, requireDraft: true });
    } catch (error) {
      blockers.push(blocker(errorCode(error), "Exact OPEN Draft pull request is unavailable."));
    }
    if (pullRequest?.mergeable !== "MERGEABLE") blockers.push(blocker("PR_NOT_MERGEABLE", "Pull request is not currently MERGEABLE."));
    if (pullRequest && baseRef && pullRequest.baseSha !== baseRef.sha) blockers.push(blocker("PR_BASE_SHA_DRIFT", "Pull request base SHA differs from the current bound base branch."));
    if (pullRequest?.reviewDecision === "CHANGES_REQUESTED") blockers.push(blocker("MATERIAL_REVIEW_FINDING", "Pull request still has changes requested."));

    if (ci.overall !== "success" || ci.requiredChecks.some((check) => check.status !== "success")) {
      blockers.push(blocker("REQUIRED_CHECKS_NOT_SUCCESSFUL", "Required checks are not all successful on the exact head."));
    }
    if (validation.status !== "passed" || validation.headSha !== expectedHeadSha || validation.treeSha !== expectedTreeSha) {
      blockers.push(blocker("VALIDATION_EVIDENCE_INVALID", "Validation evidence is not passed on the exact head and tree."));
    }
    const independentReviewRequired = task.independentReviewRequired !== false;
    if (
      independentReviewRequired
      && (independentReview.status !== "passed" || independentReview.headSha !== expectedHeadSha || independentReview.treeSha !== expectedTreeSha)
    ) {
      blockers.push(blocker("INDEPENDENT_REVIEW_INVALID", "Required independent review is not passed on the exact head and tree."));
    }
    const materialFindingCount = independentReview.materialFindingCount
      ?? (independentReviewRequired && independentReview.status !== "passed" ? 1 : 0);
    if (materialFindingCount !== 0) blockers.push(blocker("MATERIAL_REVIEW_FINDINGS_REMAIN", "Independent review reports material findings."));
    if (operations.some((operation) => operation.phase === "UNKNOWN_AFTER_CONTACT")) {
      blockers.push(blocker("UNKNOWN_EXTERNAL_EFFECT", "Task has an unresolved unknown external effect."));
    }

    let unresolvedThreadIds: string[] = [];
    if (pullRequest) {
      const threads = await listAllExactReviewThreads({ github: this.github, task, pullRequest });
      unresolvedThreadIds = threads.filter((thread) => !thread.isResolved).map((thread) => thread.id).sort();
      if (unresolvedThreadIds.length > 0) blockers.push(blocker("UNRESOLVED_REVIEW_THREADS", "Pull request has unresolved review threads."));
    }

    const preparedAt = fixed?.preparedAt ?? this.clock.now().toISOString();
    const expiresAt = fixed?.expiresAt ?? new Date(Date.parse(preparedAt) + this.manifestTtlMs).toISOString();
    const core: MergeGateManifestCore = {
      repoId: task.repoId,
      taskId: task.taskId,
      repositoryId: repository.id,
      repositoryNameWithOwner: repository.nameWithOwner,
      pullRequestId: pullRequest?.id ?? "missing",
      pullRequestNumber: pullRequest?.number ?? 1,
      pullRequestState: "OPEN",
      pullRequestDraft: true,
      pullRequestMergeable: "MERGEABLE",
      baseBranch: task.baseBranch,
      baseSha: baseRef?.sha ?? "0000000000000000000000000000000000000000",
      taskBranch: task.branch,
      headSha: assertSha(expectedHeadSha),
      treeSha: assertSha(expectedTreeSha),
      mergeMethod: task.mergeMethod,
      deleteTaskBranch: false,
      retainTaskBranch: true,
      requiredRunIds: ci.workflowRuns
        .filter((run) => run.status === "completed" && run.conclusion === "success")
        .map((run) => String(run.id))
        .sort((left, right) => Number(left) - Number(right)),
      unresolvedThreadIds,
      ciStatusId: fixed?.ciStatusId ?? ci.ciStatusId,
      ciEvidenceDigest: ci.stateDigest,
      validationId: validation.validationId,
      validationDigest: assertDigest(validation.digest, "validation digest"),
      independentReviewId: independentReview.reviewId,
      independentReviewDigest: assertDigest(independentReview.digest, "independent review digest"),
      independentReviewRequired,
      materialFindingCount: 0,
      postMergePlan: {
        readbackRequired: true,
        retainTaskBranch: true,
        verifyBaseContainsHead: true
      },
      preparedAt,
      expiresAt
    };
    return { blockers: deduplicateBlockers(blockers), core };
  }
}

export function parseMergeGateManifestCore(value: JsonValue): MergeGateManifestCore {
  if (!isRecord(value)) throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Merge manifest is not a fixed JSON object.");
  const stringField = (name: string): string => {
    const field = value[name];
    if (typeof field !== "string") throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", `Merge manifest ${name} is invalid.`);
    return field;
  };
  const numberField = (name: string): number => {
    const field = value[name];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field <= 0) {
      throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", `Merge manifest ${name} is invalid.`);
    }
    return field;
  };
  const stringArray = (name: string): string[] => {
    const field = value[name];
    if (!Array.isArray(field) || !field.every((entry) => typeof entry === "string")) {
      throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", `Merge manifest ${name} is invalid.`);
    }
    return field;
  };
  const mergeMethod = stringField("mergeMethod");
  if (mergeMethod !== "merge" && mergeMethod !== "squash" && mergeMethod !== "rebase") {
    throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Merge manifest merge method is invalid.");
  }
  const postMergePlan = value.postMergePlan;
  if (
    !isRecord(postMergePlan)
    || postMergePlan.readbackRequired !== true
    || postMergePlan.retainTaskBranch !== true
    || postMergePlan.verifyBaseContainsHead !== true
  ) {
    throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Merge manifest post-merge plan is invalid.");
  }
  if (
    value.pullRequestState !== "OPEN"
    || value.pullRequestDraft !== true
    || value.pullRequestMergeable !== "MERGEABLE"
    || value.deleteTaskBranch !== false
    || value.retainTaskBranch !== true
    || typeof value.independentReviewRequired !== "boolean"
    || value.materialFindingCount !== 0
  ) {
    throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Merge manifest fixed safety fields are invalid.");
  }
  return {
    repoId: assertSafeIdentifier(stringField("repoId"), "manifest repo id"),
    taskId: assertSafeIdentifier(stringField("taskId"), "manifest task id"),
    repositoryId: assertOpaqueNodeId(stringField("repositoryId"), "manifest repository id"),
    repositoryNameWithOwner: assertRepositoryNameWithOwner(stringField("repositoryNameWithOwner")),
    pullRequestId: assertOpaqueNodeId(stringField("pullRequestId"), "manifest pull request id"),
    pullRequestNumber: numberField("pullRequestNumber"),
    pullRequestState: "OPEN",
    pullRequestDraft: true,
    pullRequestMergeable: "MERGEABLE",
    baseBranch: assertSafeBranch(stringField("baseBranch")),
    baseSha: assertSha(stringField("baseSha"), "manifest base sha"),
    taskBranch: assertSafeBranch(stringField("taskBranch")),
    headSha: assertSha(stringField("headSha"), "manifest head sha"),
    treeSha: assertSha(stringField("treeSha"), "manifest tree sha"),
    mergeMethod,
    deleteTaskBranch: false,
    retainTaskBranch: true,
    requiredRunIds: stringArray("requiredRunIds").map(assertRunId),
    unresolvedThreadIds: stringArray("unresolvedThreadIds").map((id) => assertOpaqueNodeId(id, "review thread id")),
    ciStatusId: assertSafeIdentifier(stringField("ciStatusId"), "CI status id"),
    ciEvidenceDigest: assertDigest(stringField("ciEvidenceDigest"), "CI evidence digest"),
    validationId: assertSafeIdentifier(stringField("validationId"), "validation id"),
    validationDigest: assertDigest(stringField("validationDigest"), "validation digest"),
    independentReviewId: assertSafeIdentifier(stringField("independentReviewId"), "independent review id"),
    independentReviewDigest: assertDigest(stringField("independentReviewDigest"), "independent review digest"),
    independentReviewRequired: value.independentReviewRequired,
    materialFindingCount: 0,
    postMergePlan: {
      readbackRequired: true,
      retainTaskBranch: true,
      verifyBaseContainsHead: true
    },
    preparedAt: assertTimestamp(stringField("preparedAt"), "prepared_at"),
    expiresAt: assertTimestamp(stringField("expiresAt"), "expires_at")
  };
}

function manifestCoreJson(core: MergeGateManifestCore): JsonValue {
  return {
    repoId: core.repoId,
    taskId: core.taskId,
    repositoryId: core.repositoryId,
    repositoryNameWithOwner: core.repositoryNameWithOwner,
    pullRequestId: core.pullRequestId,
    pullRequestNumber: core.pullRequestNumber,
    pullRequestState: core.pullRequestState,
    pullRequestDraft: core.pullRequestDraft,
    pullRequestMergeable: core.pullRequestMergeable,
    baseBranch: core.baseBranch,
    baseSha: core.baseSha,
    taskBranch: core.taskBranch,
    headSha: core.headSha,
    treeSha: core.treeSha,
    mergeMethod: core.mergeMethod,
    deleteTaskBranch: core.deleteTaskBranch,
    retainTaskBranch: core.retainTaskBranch,
    requiredRunIds: core.requiredRunIds,
    unresolvedThreadIds: core.unresolvedThreadIds,
    ciStatusId: core.ciStatusId,
    ciEvidenceDigest: core.ciEvidenceDigest,
    validationId: core.validationId,
    validationDigest: core.validationDigest,
    independentReviewId: core.independentReviewId,
    independentReviewDigest: core.independentReviewDigest,
    independentReviewRequired: core.independentReviewRequired,
    materialFindingCount: core.materialFindingCount,
    postMergePlan: core.postMergePlan,
    preparedAt: core.preparedAt,
    expiresAt: core.expiresAt
  };
}

function ownerCommand(manifestId: string): string {
  return `chat-pro-repo approve-merge --gate-id ${manifestId}`;
}

function blocker(code: string, message: string): MergeGateBlocker {
  return { code, message };
}

function deduplicateBlockers(blockers: MergeGateBlocker[]): MergeGateBlocker[] {
  const byCode = new Map(blockers.map((entry) => [entry.code, entry]));
  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function assertDigest(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new GitHubBoundaryError("INVALID_DIGEST", `${field} is not an exact SHA-256 digest.`);
  return value;
}

function assertRunId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Merge manifest run id is invalid.");
  return value;
}

function assertOpaqueNodeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9_=:.-]{1,500}$/.test(value)) {
    throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", `${field} is invalid.`);
  }
  return value;
}

function assertRepositoryNameWithOwner(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", "Manifest repository identity is invalid.");
  }
  return value;
}

function assertTimestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new GitHubBoundaryError("MERGE_MANIFEST_INVALID", `${field} is not an RFC 3339 timestamp.`);
  return value;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "MERGE_GATE_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("MERGE_GATE_FAILED", "Merge gate evaluation failed without exposing external output.");
  return Object.assign(boundary, { operation });
}
