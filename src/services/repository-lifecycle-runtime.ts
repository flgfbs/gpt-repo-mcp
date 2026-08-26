import {
  RepoTaskAdmissionResultSchema,
  type RepoTaskAdmissionInput,
  type RepoTaskAdmissionResult
} from "../contracts/task-admission.contract.js";
import {
  RepoArtifactReadResultSchema,
  RepoTaskCleanupResultSchema,
  RepoTaskCloseResultSchema,
  RepoTaskOpenResultSchema,
  RepoTaskStatusResultSchema,
  type RepoArtifactReadInput,
  type RepoArtifactReadResult,
  type RepoCiStatusInput,
  type RepoCiStatusResult,
  type RepoMergeGatePrepareInput,
  type RepoMergeGatePrepareResult,
  type RepoPostMergeReadbackInput,
  type RepoPostMergeReadbackResult,
  type RepoPrCreateOrUpdateInput,
  type RepoPrCreateOrUpdateResult,
  type RepoPrReviewThreadsInput,
  type RepoPrReviewThreadsResult,
  type RepoPrStatusInput,
  type RepoPrStatusResult,
  type RepoRemoteStatusInput,
  type RepoRemoteStatusResult,
  type RepoTaskCleanupInput,
  type RepoTaskCleanupResult,
  type RepoTaskCloseInput,
  type RepoTaskCloseResult,
  type RepoTaskOpenInput,
  type RepoTaskOpenResult,
  type RepoTaskStatusInput,
  type RepoTaskStatusResult,
  type RepoWriteCiRetryFailedInput,
  type RepoWriteCiRetryFailedResult,
  type RepoWriteMergeInput,
  type RepoWriteMergeResult,
  type RepoWritePrReplyInput,
  type RepoWritePrReplyResult,
  type RepoWritePrResolveThreadInput,
  type RepoWritePrResolveThreadResult,
  type RepoWritePushInput,
  type RepoWritePushResult
} from "../contracts/lifecycle.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import {
  TaskArtifactStore,
  canonicalJson,
  canonicalSha256,
  type TaskArtifactMetadata,
  type TaskRuntimeService,
  type TaskState
} from "../task-runtime/index.js";
import type { LifecycleRuntime } from "./lifecycle-runtime.js";
import { TaskAdmissionService } from "./task-admission-service.js";
import type { RootRegistry } from "./root-registry.js";

export type ExternalLifecycleRuntime = Pick<LifecycleRuntime,
  | "remoteStatus"
  | "writePush"
  | "prCreateOrUpdate"
  | "prStatus"
  | "prReviewThreads"
  | "writePrReply"
  | "writePrResolveThread"
  | "ciStatus"
  | "writeCiRetryFailed"
  | "mergeGatePrepare"
  | "writeMerge"
  | "postMergeReadback"
>;

export class RepositoryLifecycleRuntime implements LifecycleRuntime {
  private readonly taskAdmissions: TaskAdmissionService;

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    private readonly artifacts: TaskArtifactStore,
    private readonly external?: ExternalLifecycleRuntime
  ) {
    this.taskAdmissions = new TaskAdmissionService(registry, tasks);
  }

  async taskOpen(input: RepoTaskOpenInput): Promise<RepoTaskOpenResult> {
    const base = this.registry.getBase(input.repo_id);
    if (!base.lifecycle) throw new RepoReaderError("LIFECYCLE_POLICY_DENIED", "Repository lifecycle policy is not configured.");
    assertTaskAuthority(base.lifecycle.authority, input.authority);
    if (!base.lifecycle.allowed_base_branches.includes(input.base_branch)) {
      throw new RepoReaderError("LIFECYCLE_POLICY_DENIED", "Requested base branch is outside the owner policy.");
    }
    const opened = await this.tasks.open({
      operation_id: input.operation_id,
      task_id: input.task_id,
      base_repo_id: input.repo_id,
      base_branch: input.base_branch,
      base_commit: input.base_commit_sha,
      base_tree: input.base_tree_sha,
      authority: input.authority,
      goal: input.goal,
      branch_slug: input.branch_slug
    });
    const artifact = await this.ensureOperationArtifact(opened.task, input.operation_id, "task_manifest", {
      semantic: "repo_task_open",
      operation_id: input.operation_id,
      task_id: input.task_id,
      task_repo_id: opened.repo_id,
      base_repo_id: input.repo_id,
      base_branch: input.base_branch,
      base_commit_sha: input.base_commit_sha,
      base_tree_sha: input.base_tree_sha,
      authority: input.authority,
      goal_sha256: canonicalSha256(input.goal),
      branch_slug: input.branch_slug
    });
    return RepoTaskOpenResultSchema.parse({
      ok: true,
      operation_id: input.operation_id,
      task: taskBinding(opened.task),
      artifact: artifactReference(artifact),
      created: !opened.recovered_from_readback,
      warnings: []
    });
  }

  async taskStatus(input: RepoTaskStatusInput): Promise<RepoTaskStatusResult> {
    const status = await this.tasks.status(input.task_id);
    assertTaskRepo(input.repo_id, status.task);
    const artifactMetadata = await this.artifacts.listMetadata(input.task_id, { limit: 201 });
    const artifacts = artifactMetadata.slice(0, 200).map(artifactReference);
    const operations = await this.tasks.states.listOperationsForTask(input.task_id);
    const warnings = [
      ...(status.task.lifecycle === "RECOVERY_REQUIRED" ? ["TASK_RECOVERY_REQUIRED"] : []),
      ...(status.observed_worktree.disposition === "EXACT" || status.observed_worktree.disposition === "ABSENT"
        ? []
        : [`WORKTREE_${status.observed_worktree.disposition}`]),
      ...(artifactMetadata.length > 200 ? ["ARTIFACTS_TRUNCATED"] : [])
    ];
    return RepoTaskStatusResultSchema.parse({
      ok: true,
      task: taskBinding(status.task, status.git_status ?? undefined),
      artifacts,
      ...(operations && operations.length > 0
        ? { last_operation_id: operations.at(-1)?.operation_id }
        : {}),
      cleanup_eligible: ["CLOSED", "CLEANUP_BLOCKED"].includes(status.task.lifecycle)
        && status.git_status?.clean !== false,
      warnings
    });
  }

  async taskAdmission(input: RepoTaskAdmissionInput): Promise<RepoTaskAdmissionResult> {
    return RepoTaskAdmissionResultSchema.parse(await this.taskAdmissions.read(input));
  }

  async taskClose(input: RepoTaskCloseInput): Promise<RepoTaskCloseResult> {
    const before = await this.tasks.status(input.task_id);
    assertTaskRepo(input.repo_id, before.task);
    const closed = await this.tasks.close({
      operation_id: input.operation_id,
      task_id: input.task_id,
      expected_head: input.expected_head_sha,
      expected_tree: input.expected_tree_sha,
      disposition: input.outcome,
      reason: input.summary
    });
    const artifact = await this.ensureOperationArtifact(closed.task, input.operation_id, "operation_receipt", {
      semantic: "repo_task_close",
      operation_id: input.operation_id,
      task_id: input.task_id,
      task_repo_id: input.repo_id,
      expected_head_sha: input.expected_head_sha,
      expected_tree_sha: input.expected_tree_sha,
      outcome: input.outcome,
      summary_sha256: canonicalSha256(input.summary),
      effect_state: closed.operation.effect_state
    });
    return RepoTaskCloseResultSchema.parse({
      ok: true,
      operation_id: input.operation_id,
      task: taskBinding(closed.task, {
        head: input.expected_head_sha,
        tree: input.expected_tree_sha
      }),
      outcome: input.outcome,
      artifact: artifactReference(artifact),
      changed: closed.operation.effect_state === "PRESENT",
      warnings: []
    });
  }

  async taskCleanup(input: RepoTaskCleanupInput): Promise<RepoTaskCleanupResult> {
    const task = await this.tasks.states.requireTask(input.task_id);
    assertTaskRepo(input.repo_id, task);
    const cleaned = await this.tasks.cleanup({
      operation_id: input.operation_id,
      task_id: input.task_id,
      expected_head: input.expected_head_sha,
      expected_tree: input.expected_tree_sha,
      cleanup_scope: input.cleanup_scope
    });
    const existingReceipt = await this.findOperationArtifact(cleaned.task, input.operation_id, "operation_receipt");
    if (existingReceipt) {
      const receipt = await this.readJsonArtifact(cleaned.task.task_id, existingReceipt);
      if (receipt.semantic !== "repo_task_cleanup" || typeof receipt.artifacts_removed !== "number") {
        throw new RepoReaderError("INTERNAL_ERROR", "Cleanup receipt is malformed or bound to another operation.");
      }
      return RepoTaskCleanupResultSchema.parse({
        ok: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        task_id: input.task_id,
        head_sha: input.expected_head_sha,
        tree_sha: input.expected_tree_sha,
        state: "cleaned",
        workspace_removed: true,
        artifacts_removed: receipt.artifacts_removed,
        changed: receipt.effect_state === "PRESENT" || receipt.artifacts_removed > 0,
        artifact: artifactReference(existingReceipt),
        warnings: receipt.local_branch_retained === true ? ["LOCAL_TASK_BRANCH_RETAINED_UNMERGED"] : []
      });
    }
    const artifactsRemoved = input.cleanup_scope === "workspace_and_artifacts"
      ? await this.artifacts.removeTaskArtifacts(input.task_id)
      : 0;
    const artifact = await this.ensureOperationArtifact(cleaned.task, input.operation_id, "operation_receipt", {
      semantic: "repo_task_cleanup",
      operation_id: input.operation_id,
      task_id: input.task_id,
      task_repo_id: input.repo_id,
      expected_head_sha: input.expected_head_sha,
      expected_tree_sha: input.expected_tree_sha,
      cleanup_scope: input.cleanup_scope,
      workspace_absent: true,
      local_branch_retained: cleaned.branch_preserved,
      artifacts_removed: artifactsRemoved,
      effect_state: cleaned.operation.effect_state
    });
    return RepoTaskCleanupResultSchema.parse({
      ok: true,
      operation_id: input.operation_id,
      repo_id: input.repo_id,
      task_id: input.task_id,
      head_sha: input.expected_head_sha,
      tree_sha: input.expected_tree_sha,
      state: "cleaned",
      workspace_removed: true,
      artifacts_removed: artifactsRemoved,
      changed: cleaned.operation.effect_state === "PRESENT" || artifactsRemoved > 0,
      artifact: artifactReference(artifact),
      warnings: cleaned.branch_preserved ? ["LOCAL_TASK_BRANCH_RETAINED_UNMERGED"] : []
    });
  }

  async artifactRead(input: RepoArtifactReadInput): Promise<RepoArtifactReadResult> {
    const task = await this.findTaskByRepoId(input.repo_id);
    const read = await this.artifacts.read({
      task_id: task.task_id,
      artifact_id: input.artifact_id,
      offset: input.offset,
      length: input.length
    });
    return RepoArtifactReadResultSchema.parse({
      ok: true,
      repo_id: input.repo_id,
      artifact_id: input.artifact_id,
      media_type: read.artifact.media_type,
      offset: read.offset,
      length: read.length,
      total_length: read.total_bytes,
      data_base64: read.content_base64,
      ...(read.eof ? {} : { next_offset: read.offset + read.length }),
      eof: read.eof,
      sha256: read.artifact.content_sha256,
      warnings: []
    });
  }

  async remoteStatus(input: RepoRemoteStatusInput): Promise<RepoRemoteStatusResult> {
    return this.requireExternal(input.repo_id).remoteStatus(input);
  }

  async writePush(input: RepoWritePushInput): Promise<RepoWritePushResult> {
    return this.requireExternal(input.repo_id).writePush(input);
  }

  async prCreateOrUpdate(input: RepoPrCreateOrUpdateInput): Promise<RepoPrCreateOrUpdateResult> {
    return this.requireExternal(input.repo_id).prCreateOrUpdate(input);
  }

  async prStatus(input: RepoPrStatusInput): Promise<RepoPrStatusResult> {
    return this.requireExternal(input.repo_id).prStatus(input);
  }

  async prReviewThreads(input: RepoPrReviewThreadsInput): Promise<RepoPrReviewThreadsResult> {
    return this.requireExternal(input.repo_id).prReviewThreads(input);
  }

  async writePrReply(input: RepoWritePrReplyInput): Promise<RepoWritePrReplyResult> {
    return this.requireExternal(input.repo_id).writePrReply(input);
  }

  async writePrResolveThread(input: RepoWritePrResolveThreadInput): Promise<RepoWritePrResolveThreadResult> {
    return this.requireExternal(input.repo_id).writePrResolveThread(input);
  }

  async ciStatus(input: RepoCiStatusInput): Promise<RepoCiStatusResult> {
    return this.requireExternal(input.repo_id).ciStatus(input);
  }

  async writeCiRetryFailed(input: RepoWriteCiRetryFailedInput): Promise<RepoWriteCiRetryFailedResult> {
    return this.requireExternal(input.repo_id).writeCiRetryFailed(input);
  }

  async mergeGatePrepare(input: RepoMergeGatePrepareInput): Promise<RepoMergeGatePrepareResult> {
    return this.requireExternal(input.repo_id).mergeGatePrepare(input);
  }

  async writeMerge(input: RepoWriteMergeInput): Promise<RepoWriteMergeResult> {
    return this.requireExternal(input.repo_id).writeMerge(input);
  }

  async postMergeReadback(input: RepoPostMergeReadbackInput): Promise<RepoPostMergeReadbackResult> {
    return this.requireExternal(input.repo_id).postMergeReadback(input);
  }

  private requireExternal(repoId: string): ExternalLifecycleRuntime {
    const task = this.registry.taskBinding(repoId);
    if (task) {
      const lifecycle = this.registry.getBase(task.base_repo_id).lifecycle;
      if (!lifecycle || lifecycle.kind !== "github") {
        throw new RepoReaderError(
          "LIFECYCLE_POLICY_DENIED",
          "Repository lifecycle is local-only; remote and GitHub lifecycle operations are not configured."
        );
      }
    }
    if (!this.external) {
      throw new RepoReaderError("LIFECYCLE_POLICY_DENIED", "Remote and GitHub lifecycle runtime is not configured.");
    }
    return this.external;
  }

  private async ensureOperationArtifact(
    task: TaskState,
    operationId: string,
    kind: "task_manifest" | "operation_receipt",
    value: Record<string, unknown>
  ): Promise<TaskArtifactMetadata> {
    const logicalPath = `receipts/${operationId}.${kind}.json`;
    return this.tasks.locks.withLock(`artifact-logical:${task.task_id}:${logicalPath}`, async () => {
      const existing = (await this.artifacts.listMetadata(task.task_id, { limit: 10_000 }))
        .find((candidate) => candidate.logical_path === logicalPath);
      if (existing) return existing;
      return this.artifacts.put({
        task_id: task.task_id,
        kind,
        media_type: "application/json",
        logical_path: logicalPath,
        content: `${canonicalJson(value)}\n`
      });
    });
  }

  private async findOperationArtifact(
    task: TaskState,
    operationId: string,
    kind: "task_manifest" | "operation_receipt"
  ): Promise<TaskArtifactMetadata | undefined> {
    const logicalPath = `receipts/${operationId}.${kind}.json`;
    return (await this.artifacts.listMetadata(task.task_id, { limit: 10_000 }))
      .find((candidate) => candidate.logical_path === logicalPath);
  }

  private async readJsonArtifact(taskId: string, artifact: TaskArtifactMetadata): Promise<Record<string, unknown>> {
    const read = await this.artifacts.read({
      task_id: taskId,
      artifact_id: artifact.artifact_id,
      offset: 0,
      length: Math.max(1, Math.min(65_536, artifact.byte_length))
    });
    if (!read.eof) throw new RepoReaderError("INTERNAL_ERROR", "Operation receipt exceeds its bounded read limit.");
    const parsed = JSON.parse(Buffer.from(read.content_base64, "base64").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new RepoReaderError("INTERNAL_ERROR", "Operation receipt is not a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  private async findTaskByRepoId(repoId: string): Promise<TaskState> {
    const matches = (await this.tasks.listTasks({ limit: 10_000 })).filter((task) => task.repo_id === repoId);
    if (matches.length !== 1) throw new RepoReaderError("UNKNOWN_REPO", "Unknown or ambiguous task repository id.");
    return matches[0]!;
  }
}

function assertTaskAuthority(repository: "read" | "write" | "ship", requested: "inspect" | "implement" | "ship"): void {
  const permitted = repository === "read"
    ? new Set(["inspect"])
    : repository === "write"
      ? new Set(["inspect", "implement"])
      : new Set(["inspect", "implement", "ship"]);
  if (!permitted.has(requested)) {
    throw new RepoReaderError("LIFECYCLE_POLICY_DENIED", "Requested task authority exceeds the owner-registered repository authority.");
  }
}

function assertTaskRepo(repoId: string, task: TaskState): void {
  if (task.repo_id !== repoId) throw new RepoReaderError("UNKNOWN_REPO", "repo_id is not bound to the requested task.");
}

function taskBinding(task: TaskState, observed?: { head: string; tree: string }) {
  const head = observed?.head ?? task.worktree_head;
  const tree = observed?.tree ?? task.worktree_tree;
  if (!head || !tree) throw new RepoReaderError("INTERNAL_ERROR", "Task state does not have an exact HEAD and tree binding.");
  return {
    repo_id: task.repo_id,
    base_repo_id: task.base_repo_id,
    task_id: task.task_id,
    authority: task.authority,
    goal: task.goal,
    base_branch: task.base_branch,
    base_commit_sha: task.base_commit,
    base_tree_sha: task.base_tree,
    branch_slug: task.branch_slug,
    task_branch: task.server_branch,
    head_sha: head,
    tree_sha: tree,
    state: task.lifecycle.toLowerCase(),
    opened_at: task.created_at,
    ...(["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "CLEANED"].includes(task.lifecycle) && task.closed_at
      ? { closed_at: task.closed_at }
      : {}),
    ...(task.lifecycle === "CLEANED" ? { cleaned_at: task.updated_at } : {})
  };
}

function artifactReference(metadata: TaskArtifactMetadata) {
  return {
    artifact_id: metadata.artifact_id,
    kind: metadata.kind,
    media_type: metadata.media_type,
    byte_length: metadata.byte_length,
    sha256: metadata.content_sha256,
    created_at: metadata.created_at
  };
}
