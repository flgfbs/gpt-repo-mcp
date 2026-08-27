import * as Lifecycle from "../contracts/lifecycle.contract.js";
import {
  GitHubBoundaryError,
  type GitHubOperationRecord,
  type JsonValue,
  type TaskLookup
} from "../github/types.js";
import { RepoReaderError } from "../runtime/errors.js";
import type { TaskArtifactMetadata } from "../task-runtime/index.js";
import type { TaskArtifactGitHubSink } from "./github-runtime-adapters.js";
import type { ExternalLifecycleRuntime } from "./repository-lifecycle-runtime.js";

type Method = keyof ExternalLifecycleRuntime;
type Input<K extends Method> = Parameters<ExternalLifecycleRuntime[K]>[0];
type Output<K extends Method> = Awaited<ReturnType<ExternalLifecycleRuntime[K]>>;
type ServiceResult = { disposition: "EXECUTED" | "STORED"; operation: GitHubOperationRecord };
type JsonRecord = { [key: string]: JsonValue };
type GitHubEvidenceReader = Pick<TaskArtifactGitHubSink, "readArtifact">;

export type GitHubLifecycleServices = {
  remote: {
    remoteStatus(input: Input<"remoteStatus">): Promise<ServiceResult>;
    writePush(input: Input<"writePush">): Promise<ServiceResult>;
  };
  pullRequests: {
    prCreateOrUpdate(input: Input<"prCreateOrUpdate">): Promise<ServiceResult>;
    prStatus(input: Input<"prStatus">): Promise<ServiceResult>;
  };
  reviews: {
    prReviewThreads(input: Input<"prReviewThreads">): Promise<ServiceResult>;
    writePrReply(input: Input<"writePrReply">): Promise<ServiceResult>;
    writePrResolveThread(input: Input<"writePrResolveThread">): Promise<ServiceResult>;
  };
  ci: {
    ciStatus(input: Input<"ciStatus">): Promise<ServiceResult>;
    writeCiRetryFailed(input: Input<"writeCiRetryFailed">): Promise<ServiceResult>;
  };
  gates: { mergeGatePrepare(input: Input<"mergeGatePrepare">): Promise<ServiceResult> };
  merge: { writeMerge(input: Input<"writeMerge">): Promise<ServiceResult> };
  postMerge: { postMergeReadback(input: Input<"postMergeReadback">): Promise<ServiceResult> };
};

type LoadedEvidence = {
  operation: GitHubOperationRecord;
  stored: boolean;
  evidence: JsonRecord;
  artifact: ReturnType<typeof publicArtifact>;
};

export class GitHubLifecycleRuntime implements ExternalLifecycleRuntime {
  constructor(
    private readonly tasks: TaskLookup,
    private readonly artifacts: GitHubEvidenceReader,
    private readonly services: GitHubLifecycleServices
  ) {}

  async remoteStatus(input: Input<"remoteStatus">): Promise<Output<"remoteStatus">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.remote.remoteStatus(input));
      const task = await this.tasks.getServerOwnedTask(input.repo_id);
      const value = loaded.evidence;
      return Lifecycle.RepoRemoteStatusResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        local_head_sha: readString(value, "localHeadSha"),
        local_tree_sha: readString(value, "localTreeSha"),
        local_branch: readString(value, "taskBranchName"),
        local_upstream: nullableString(value.localUpstream, "localUpstream") ?? null,
        remote_name: readString(value, "remoteName"),
        normalized_remote_identity: readString(value, "normalizedRemoteIdentity"),
        configured_repository_identity: readString(value, "configuredRepositoryIdentity"),
        default_branch: exactRef(
          readString(value, "defaultBranchName"),
          value.defaultBranchHeadSha,
          value.defaultBranchTreeSha
        ),
        task_branch: exactRef(task.branch, value.remoteHeadSha, value.remoteTreeSha),
        relationship: readString(value, "relationship"),
        observed_at: loaded.operation.updatedAt,
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async writePush(input: Input<"writePush">): Promise<Output<"writePush">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.remote.writePush(input));
      const value = loaded.evidence;
      const operation = operationResult(loaded.operation);
      const pushed = readBoolean(value, "pushed");
      return Lifecycle.RepoWritePushResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        task_branch: readString(value, "taskBranch"),
        head_sha: input.expected_head_sha,
        tree_sha: input.expected_tree_sha,
        remote_before: exactRef(readString(value, "taskBranch"), value.remoteBefore, value.remoteBeforeTree),
        remote_after: exactRef(readString(value, "taskBranch"), value.remoteAfter, value.remoteAfterTree),
        fast_forward_only: true,
        force_used: false,
        contact: {
          pre_contact_recorded: true,
          post_contact_recorded: true,
          effect_state: pushed
            ? operation.reconciled === true ? "queryable_effect" : "pushed"
            : "no_change",
          recorded_at: loaded.operation.updatedAt
        },
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async prCreateOrUpdate(input: Input<"prCreateOrUpdate">): Promise<Output<"prCreateOrUpdate">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.pullRequests.prCreateOrUpdate(input));
      return Lifecycle.RepoPrCreateOrUpdateResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        action: readString(operationResult(loaded.operation), "action"),
        pull_request: publicPullRequest(readRecord(loaded.evidence, "pullRequest")),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async prStatus(input: Input<"prStatus">): Promise<Output<"prStatus">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.pullRequests.prStatus(input));
      const pullRequest = loaded.evidence.pullRequest;
      return Lifecycle.RepoPrStatusResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        pull_request: pullRequest === null ? null : publicPullRequest(asRecord(pullRequest, "pullRequest")),
        observed_at: loaded.operation.updatedAt,
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async prReviewThreads(input: Input<"prReviewThreads">): Promise<Output<"prReviewThreads">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.reviews.prReviewThreads(input));
      const value = loaded.evidence;
      const nextCursor = nullableString(value.nextCursor, "nextCursor");
      return Lifecycle.RepoPrReviewThreadsResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        pull_request_number: readNumber(value, "pullRequestNumber"),
        threads: readArray(value, "threads").map((thread) => publicReviewThread(asRecord(thread, "thread"))),
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
        truncated: nextCursor !== undefined,
        observed_at: readString(value, "observedAt"),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async writePrReply(input: Input<"writePrReply">): Promise<Output<"writePrReply">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.reviews.writePrReply(input));
      const value = loaded.evidence;
      return Lifecycle.RepoWritePrReplyResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        pull_request_number: readNumber(value, "pullRequestNumber"),
        thread_id: readString(value, "threadId"),
        comment: publicReviewComment(readRecord(value, "comment")),
        created: !loaded.stored,
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async writePrResolveThread(input: Input<"writePrResolveThread">): Promise<Output<"writePrResolveThread">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.reviews.writePrResolveThread(input));
      const value = loaded.evidence;
      const thread = readRecord(value, "thread");
      return Lifecycle.RepoWritePrResolveThreadResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        pull_request_number: readNumber(value, "pullRequestNumber"),
        thread_id: readString(thread, "id"),
        resolved: true,
        changed: readBoolean(value, "changed"),
        updated_at: readString(thread, "updatedAt"),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async ciStatus(input: Input<"ciStatus">): Promise<Output<"ciStatus">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.ci.ciStatus(input));
      const value = loaded.evidence;
      const requiredCheckEvidence = readArray(value, "requiredChecks").map((entry) => {
        const check = asRecord(entry, "required check");
        const sourceId = nullableSourceId(check.sourceId, "sourceId");
        const sourceIds = requiredCheckSourceIds(check.sourceIds, sourceId);
        return { check, sourceId, sourceIds };
      });
      const multipleSourceCheck = requiredCheckEvidence.some(({ sourceIds }) => (sourceIds?.length ?? 0) > 1);
      return Lifecycle.RepoCiStatusResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        ci_status_id: readString(operationResult(loaded.operation), "ciStatusId"),
        head_sha: readString(value, "headSha"),
        overall: readString(value, "overall"),
        required_checks: requiredCheckEvidence.map(({ check, sourceId }) => {
          const required = readRecord(check, "required");
          const conclusion = nullableString(check.conclusion, "conclusion");
          return {
            key: readString(check, "key"),
            kind: readString(required, "kind"),
            status: readString(check, "status"),
            ...(sourceId === undefined ? {} : { source_id: String(sourceId) }),
            ...(conclusion === undefined ? {} : { conclusion })
          };
        }),
        runs: readArray(value, "workflowRuns").map(publicWorkflowRun),
        observed_at: readString(value, "observedAt"),
        artifact: loaded.artifact,
        warnings: multipleSourceCheck ? ["CI_REQUIRED_CHECK_MULTIPLE_SOURCES_AGGREGATED"] : []
      });
    });
  }

  async writeCiRetryFailed(input: Input<"writeCiRetryFailed">): Promise<Output<"writeCiRetryFailed">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.ci.writeCiRetryFailed(input));
      const result = operationResult(loaded.operation);
      return Lifecycle.RepoWriteCiRetryFailedResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        ci_status_id: readString(result, "ciStatusId"),
        retried_run_ids: readStringArray(result, "retriedRunIds"),
        skipped_run_ids: readStringArray(result, "skippedRunIds"),
        changed: readBoolean(result, "changed"),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async mergeGatePrepare(input: Input<"mergeGatePrepare">): Promise<Output<"mergeGatePrepare">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.gates.mergeGatePrepare(input), true);
      const result = operationResult(loaded.operation);
      const eligible = readBoolean(result, "eligible");
      if (!eligible) {
        return Lifecycle.RepoMergeGatePrepareResultSchema.parse({
          ok: true,
          operation_id: input.operation_id,
          repo_id: input.repo_id,
          task_id: input.task_id,
          eligible: false,
          blockers: readArray(loaded.evidence, "blockers").map((entry) => {
            const blocker = asRecord(entry, "merge blocker");
            return { code: readString(blocker, "code"), message: readString(blocker, "message") };
          }),
          manifest: null,
          approval_surface: "owner_cli",
          approval_command: null,
          artifact: loaded.artifact,
          warnings: []
        });
      }
      const manifestId = readString(result, "manifestId");
      const manifestSha256 = readString(result, "manifestSha256");
      return Lifecycle.RepoMergeGatePrepareResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        eligible: true,
        blockers: [],
        manifest: publicManifest(loaded.evidence, manifestId, manifestSha256),
        approval_surface: "owner_cli",
        approval_command: `chat-pro-repo approve-merge --gate-id ${manifestId}`,
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async writeMerge(input: Input<"writeMerge">): Promise<Output<"writeMerge">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.merge.writeMerge(input));
      const value = loaded.evidence;
      const result = operationResult(loaded.operation);
      return Lifecycle.RepoWriteMergeResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        manifest_id: readString(value, "manifestId"),
        manifest_sha256: readString(value, "manifestSha256"),
        approval_id: readString(value, "approvalId"),
        approval_consumed: true,
        pull_request_number: readNumber(value, "pullRequestNumber"),
        merge_method: readString(value, "mergeMethod"),
        effect: result.reconciled === true ? "already_merged" : "merged",
        merged_head_sha: readString(value, "mergedHeadSha"),
        merge_commit_sha: readString(value, "mergeCommitSha"),
        merged_at: readString(value, "mergedAt"),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  async postMergeReadback(input: Input<"postMergeReadback">): Promise<Output<"postMergeReadback">> {
    return this.guard(async () => {
      const loaded = await this.load(input.task_id, await this.services.postMerge.postMergeReadback(input));
      const value = loaded.evidence;
      const task = await this.tasks.getServerOwnedTask(input.repo_id);
      const pullRequestConfirmed = readBoolean(value, "pullRequestConfirmed");
      const mainCiStatusId = nullableString(value.mainCiStatusId, "mainCiStatusId");
      const mainCiOverall = nullableString(value.mainCiOverall, "mainCiOverall");
      return Lifecycle.RepoPostMergeReadbackResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        merge_operation_id: input.merge_operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        pull_request_number: readNumber(value, "pullRequestNumber"),
        pull_request_state: pullRequestConfirmed ? "merged" : "not_confirmed",
        pull_request_confirmed: pullRequestConfirmed,
        merged_head_sha: readString(value, "mergedHeadSha"),
        merge_commit_sha: readString(value, "mergeCommitSha"),
        expected_base_sha: readString(value, "expectedBaseBeforeMergeSha"),
        base_branch: exactRef(task.baseBranch, value.baseHeadSha, value.baseHeadTreeSha),
        task_branch: exactRef(task.branch, value.taskBranchHeadSha, value.taskBranchTreeSha),
        base_advanced: readBoolean(value, "baseAdvanced"),
        base_contains_merge_commit: readBoolean(value, "baseContainsMergeCommit"),
        task_branch_retained: readBoolean(value, "taskBranchRetained"),
        main_ci_status_id: mainCiStatusId ?? null,
        main_ci_overall: mainCiOverall ?? null,
        main_required_checks: readArray(value, "mainRequiredChecks").map((entry) => {
          const check = asRecord(entry, "main required check");
          return { key: readString(check, "key"), status: readString(check, "status") };
        }),
        readback_state: readString(value, "readbackState"),
        task_disposition: readString(value, "taskDisposition"),
        observed_at: readString(value, "observedAt"),
        artifact: loaded.artifact,
        warnings: []
      });
    });
  }

  private async load(taskId: string, result: ServiceResult, allowBlocked = false): Promise<LoadedEvidence> {
    const operation = result.operation;
    const accepted = operation.phase === "EXTERNAL_SUCCEEDED"
      || (allowBlocked && operation.phase === "BLOCKED" && operationResult(operation).eligible === false);
    if (!accepted) throw storedOperationError(operation);
    const artifactId = readString(operationResult(operation), "artifactId");
    const loaded = await this.artifacts.readArtifact(taskId, artifactId);
    return {
      operation,
      stored: result.disposition === "STORED",
      evidence: asRecord(loaded.value, "GitHub evidence"),
      artifact: publicArtifact(loaded.metadata)
    };
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RepoReaderError) throw error;
      if (error instanceof GitHubBoundaryError) throw boundaryError(error);
      throw new RepoReaderError("INTERNAL_ERROR", "External lifecycle evidence failed its fixed public contract.");
    }
  }
}

function publicArtifact(metadata: TaskArtifactMetadata) {
  return {
    artifact_id: metadata.artifact_id,
    kind: metadata.kind,
    media_type: metadata.media_type,
    byte_length: metadata.byte_length,
    sha256: metadata.content_sha256,
    created_at: metadata.created_at
  };
}

function publicPullRequest(value: JsonRecord) {
  return {
    number: readNumber(value, "number"),
    url: readString(value, "url"),
    state: readString(value, "state").toLowerCase(),
    draft: readBoolean(value, "draft"),
    title: readString(value, "title"),
    base_branch: readString(value, "baseBranch"),
    head_branch: readString(value, "headBranch"),
    head_sha: readString(value, "headSha"),
    mergeable: readString(value, "mergeable").toLowerCase(),
    updated_at: readString(value, "updatedAt")
  };
}

function publicReviewThread(value: JsonRecord) {
  const line = nullableNumber(value.line, "line");
  const side = nullableString(value.side, "side");
  return {
    thread_id: readString(value, "id"),
    path: readString(value, "path"),
    ...(line === undefined ? {} : { line }),
    ...(side === undefined ? {} : { side }),
    resolved: readBoolean(value, "resolved"),
    outdated: readBoolean(value, "outdated"),
    comments: readArray(value, "comments").map((entry) => publicReviewComment(asRecord(entry, "review comment"))),
    updated_at: readString(value, "updatedAt")
  };
}

function publicReviewComment(value: JsonRecord) {
  const body = readString(value, "body");
  const excerpt = body.slice(0, 4_096);
  return {
    comment_id: readString(value, "id"),
    author: readString(value, "author"),
    body_excerpt: excerpt,
    body_truncated: excerpt.length !== body.length,
    created_at: readString(value, "createdAt"),
    updated_at: readString(value, "updatedAt"),
    url: readString(value, "url")
  };
}

function publicWorkflowRun(value: JsonValue) {
  const run = asRecord(value, "workflow run");
  const conclusion = nullableString(run.conclusion, "conclusion");
  return {
    run_id: String(readNumber(run, "id")),
    workflow_name: readString(run, "workflowName"),
    head_sha: readString(run, "headSha"),
    attempt: readNumber(run, "attempt"),
    status: readString(run, "status"),
    conclusion: conclusion ?? null,
    url: readString(run, "url"),
    event: readString(run, "event"),
    created_at: readString(run, "createdAt"),
    updated_at: readString(run, "updatedAt"),
    jobs: readArray(run, "jobs").map((entry) => {
      const job = asRecord(entry, "workflow job");
      const jobConclusion = nullableString(job.conclusion, "job conclusion");
      const startedAt = nullableString(job.startedAt, "job startedAt");
      const completedAt = nullableString(job.completedAt, "job completedAt");
      return {
        job_id: String(readNumber(job, "id")),
        name: readString(job, "name"),
        status: readString(job, "status"),
        conclusion: jobConclusion ?? null,
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(completedAt ? { completed_at: completedAt } : {}),
        url: readString(job, "url"),
        failure_summary: readStringArray(job, "failureSummary")
      };
    }),
    checks: []
  };
}

function publicManifest(core: JsonRecord, manifestId: string, manifestSha256: string) {
  const plan = readRecord(core, "postMergePlan");
  return {
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    repo_id: readString(core, "repoId"),
    task_id: readString(core, "taskId"),
    repository_id: readString(core, "repositoryId"),
    repository_name_with_owner: readString(core, "repositoryNameWithOwner"),
    pull_request_id: readString(core, "pullRequestId"),
    pull_request_number: readNumber(core, "pullRequestNumber"),
    pull_request_state: "open",
    pull_request_draft: true,
    pull_request_mergeable: "mergeable",
    base_branch: readString(core, "baseBranch"),
    base_sha: readString(core, "baseSha"),
    task_branch: readString(core, "taskBranch"),
    head_sha: readString(core, "headSha"),
    tree_sha: readString(core, "treeSha"),
    merge_method: readString(core, "mergeMethod"),
    remote_branch_retained: true,
    required_run_ids: readStringArray(core, "requiredRunIds"),
    unresolved_thread_ids: readStringArray(core, "unresolvedThreadIds"),
    ci_status_id: readString(core, "ciStatusId"),
    ci_evidence_sha256: readString(core, "ciEvidenceDigest"),
    validation_id: readString(core, "validationId"),
    validation_sha256: readString(core, "validationDigest"),
    independent_review_id: readString(core, "independentReviewId"),
    independent_review_sha256: readString(core, "independentReviewDigest"),
    independent_review_required: readBoolean(core, "independentReviewRequired"),
    material_finding_count: 0,
    unknown_external_effect_count: 0,
    post_merge_plan: {
      readback_required: readBoolean(plan, "readbackRequired"),
      retain_task_branch: readBoolean(plan, "retainTaskBranch"),
      verify_base_contains_head: readBoolean(plan, "verifyBaseContainsHead")
    },
    prepared_at: readString(core, "preparedAt"),
    expires_at: readString(core, "expiresAt")
  };
}

function exactRef(name: string, headValue: JsonValue | undefined, treeValue: JsonValue | undefined) {
  const head = nullableString(headValue, `${name} head`);
  const tree = nullableString(treeValue, `${name} tree`);
  if ((head === undefined) !== (tree === undefined)) {
    throw new GitHubBoundaryError("REMOTE_REF_EVIDENCE_INVALID", "Remote ref evidence lacks an exact head/tree pair.");
  }
  return head && tree
    ? { name, exists: true, head_sha: head, tree_sha: tree }
    : { name, exists: false };
}

function operationResult(operation: GitHubOperationRecord): JsonRecord {
  return asRecord(operation.result, "operation result");
}

function storedOperationError(operation: GitHubOperationRecord): RepoReaderError {
  if (operation.phase === "UNKNOWN_AFTER_CONTACT" || operation.phase === "EXTERNAL_CONTACTED") {
    return new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "External effect is unknown; this operation will not be replayed.", {
      diagnostics: operationDiagnostics(operation)
    });
  }
  return new RepoReaderError("TASK_OPERATION_BLOCKED", "Stored external operation is not a completed queryable result.", {
    diagnostics: operationDiagnostics(operation)
  });
}

function boundaryError(error: GitHubBoundaryError): RepoReaderError {
  const operation = operationFromError(error);
  if (operation) {
    if (operation.phase === "UNKNOWN_AFTER_CONTACT" || (operation.phase === "EXTERNAL_CONTACTED" && error.effect === "UNKNOWN")) {
      return new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "External effect is unknown; replay is prohibited.", {
        diagnostics: operationDiagnostics(operation, error.code)
      });
    }
    return new RepoReaderError("TASK_OPERATION_BLOCKED", `External lifecycle operation stopped at ${operation.phase}.`, {
      diagnostics: operationDiagnostics(operation, error.code)
    });
  }
  return new RepoReaderError("TASK_OPERATION_BLOCKED", `External lifecycle admission failed with ${error.code}.`, {
    diagnostics: { failure_code: error.code }
  });
}

function operationFromError(error: GitHubBoundaryError): GitHubOperationRecord | undefined {
  if (!("operation" in error)) return undefined;
  const value = error.operation;
  return typeof value === "object" && value !== null && "operationId" in value
    ? value as GitHubOperationRecord
    : undefined;
}

function operationDiagnostics(operation: GitHubOperationRecord, failureCode = operation.failureCode) {
  return {
    operation_id: operation.operationId,
    phase: operation.phase,
    ...(failureCode ? { failure_code: failureCode } : {})
  };
}

function asRecord(value: JsonValue | undefined, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${field} is not a fixed JSON object.`);
  }
  return value;
}

function readRecord(value: JsonRecord, key: string): JsonRecord {
  return asRecord(value[key], key);
}

function readString(value: JsonRecord, key: string): string {
  const selected = value[key];
  if (typeof selected !== "string") throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${key} is not a string.`);
  return selected;
}

function readNumber(value: JsonRecord, key: string): number {
  const selected = value[key];
  if (typeof selected !== "number" || !Number.isSafeInteger(selected)) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${key} is not a safe integer.`);
  }
  return selected;
}

function readBoolean(value: JsonRecord, key: string): boolean {
  const selected = value[key];
  if (typeof selected !== "boolean") throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${key} is not a boolean.`);
  return selected;
}

function readArray(value: JsonRecord, key: string): JsonValue[] {
  const selected = value[key];
  if (!Array.isArray(selected)) throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${key} is not an array.`);
  return selected;
}

function readStringArray(value: JsonRecord, key: string): string[] {
  const selected = readArray(value, key);
  if (!selected.every((entry) => typeof entry === "string")) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${key} is not a string array.`);
  }
  return selected;
}

function nullableString(value: JsonValue | undefined, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${field} is not a nullable string.`);
  return value;
}

function nullableNumber(value: JsonValue | undefined, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${field} is not a nullable safe integer.`);
  }
  return value;
}

function nullableSourceId(value: JsonValue | undefined, field: string): number | undefined {
  const sourceId = nullableNumber(value, field);
  if (sourceId !== undefined && sourceId <= 0) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", `${field} is not a positive safe integer.`);
  }
  return sourceId;
}

function requiredCheckSourceIds(value: JsonValue | undefined, sourceId: number | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const sourceIds = Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
    : [];
  if (
    !Array.isArray(value)
    || sourceIds.length !== value.length
    || new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((candidate, index) => index > 0 && sourceIds[index - 1]! >= candidate)
    || (sourceIds.length === 0 && sourceId !== undefined)
    || (sourceIds.length === 1 && sourceId !== sourceIds[0])
    || (sourceIds.length > 1 && sourceId !== undefined)
  ) {
    throw new GitHubBoundaryError("EVIDENCE_SCHEMA_INVALID", "Required-check source identity is invalid.");
  }
  return sourceIds;
}
