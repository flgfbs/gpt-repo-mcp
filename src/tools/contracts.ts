import type { z } from "zod";
import { RepoTaskAdmissionInputSchema, RepoTaskAdmissionResultSchema } from "../contracts/task-admission.contract.js";
import { AgentRunsInputSchema, AgentRunsResultSchema } from "../contracts/agent-runs.contract.js";
import { AgentReplyInputSchema, AgentReplyResultSchema } from "../contracts/agent-reply.contract.js";
import { AgentContinuationInputSchema, AgentContinuationResultSchema } from "../contracts/agent-continuation.contract.js";
import { ChangePlanInputSchema, ChangePlanResultSchema } from "../contracts/change-plan.contract.js";
import { CodeIndexInputSchema, CodeIndexResultSchema } from "../contracts/code-index.contract.js";
import { CleanupPathsInputSchema, CleanupPathsResultSchema } from "../contracts/cleanup.contract.js";
import { CodexReviewInputSchema, CodexReviewResultSchema } from "../contracts/codex-task.contract.js";
import { RepoFinalizeCodexRunInputSchema, RepoFinalizeCodexRunResultSchema } from "../contracts/codex-run-finalizer.contract.js";
import { CodexReviewWriteInputSchema, CodexReviewWriteResultSchema } from "../contracts/codex-review-attestation.contract.js";
import {
  DelegationPreparedResultV3Schema,
  DelegationTaskV3ToolInputSchema,
  DelegationTaskV3WriteToolInputSchema,
  DelegationWriteResultV3Schema
} from "../contracts/delegation-v3.contract.js";
import { ContextMapInputSchema, ContextMapResultSchema } from "../contracts/context-map.contract.js";
import { DecisionLogInputSchema, DecisionLogResultSchema } from "../contracts/decision.contract.js";
import { FetchFileInputSchema, FileContentSchema, ReadManyInputSchema, ReadManyResultSchema } from "../contracts/file.contract.js";
import { FailureDiagnoseInputSchema, FailureDiagnoseResultSchema } from "../contracts/failure-diagnose.contract.js";
import {
  RepoRunFableReviewInputSchema,
  RepoRunFableReviewResultSchema
} from "../contracts/fable-review.contract.js";
import { GitCommitInputSchema, GitCommitResultSchema, GitRecoverInputSchema, GitRecoverResultSchema, GitRestorePathsInputSchema, GitRestorePathsResultSchema, GitStageCommitInputSchema, GitStageCommitResultSchema, GitStageInputSchema, GitStageResultSchema, GitUnstageInputSchema, GitUnstageResultSchema } from "../contracts/git-operations.contract.js";
import { GitDiffInputSchema, GitDiffResultSchema, GitStatusInputSchema, GitStatusResultSchema } from "../contracts/git.contract.js";
import { GitReviewInputSchema, GitReviewResultSchema } from "../contracts/git-review.contract.js";
import { HandoffInputSchema, HandoffResultSchema } from "../contracts/handoff.contract.js";
import { IntegrationReviewWriteInputSchema, IntegrationReviewWriteResultSchema } from "../contracts/integration-review.contract.js";
import {
  RepoArtifactReadInputSchema,
  RepoArtifactReadResultSchema,
  RepoCiStatusInputSchema,
  RepoCiStatusResultSchema,
  RepoMergeGatePrepareInputSchema,
  RepoMergeGatePrepareResultSchema,
  RepoPostMergeReadbackInputSchema,
  RepoPostMergeReadbackResultSchema,
  RepoPrCreateOrUpdateInputSchema,
  RepoPrCreateOrUpdateResultSchema,
  RepoPrReviewThreadsInputSchema,
  RepoPrReviewThreadsResultSchema,
  RepoPrStatusInputSchema,
  RepoPrStatusResultSchema,
  RepoRemoteStatusInputSchema,
  RepoRemoteStatusResultSchema,
  RepoTaskCleanupInputSchema,
  RepoTaskCleanupResultSchema,
  RepoTaskCloseInputSchema,
  RepoTaskCloseResultSchema,
  RepoTaskOpenInputSchema,
  RepoTaskOpenResultSchema,
  RepoTaskStatusInputSchema,
  RepoTaskStatusResultSchema,
  RepoWriteCiRetryFailedInputSchema,
  RepoWriteCiRetryFailedResultSchema,
  RepoWriteMergeInputSchema,
  RepoWriteMergeResultSchema,
  RepoWritePrReplyInputSchema,
  RepoWritePrReplyResultSchema,
  RepoWritePrResolveThreadInputSchema,
  RepoWritePrResolveThreadResultSchema,
  RepoWritePushInputSchema,
  RepoWritePushResultSchema,
  LifecycleGitObjectIdSchema,
  LifecycleOperationIdSchema
} from "../contracts/lifecycle.contract.js";
import { LastWriteInputSchema, LastWriteResultSchema } from "../contracts/operation-receipt.contract.js";
import { OperationLedgerInputSchema, OperationLedgerResultSchema } from "../contracts/operation-ledger.contract.js";
import { PatchsetApplyInputSchema, PatchsetApplyResultSchema, PatchsetPrepareInputSchema, PatchsetPrepareResultSchema, PatchsetReviewInputSchema, PatchsetReviewResultSchema, PatchsetRollbackInputSchema, PatchsetRollbackResultSchema } from "../contracts/patchset.contract.js";
import { PolicyExplainInputSchema, PolicyExplainResultSchema } from "../contracts/policy.contract.js";
import { ProjectBriefInputSchema, ProjectBriefResultSchema } from "../contracts/project.contract.js";
import { RepoInputSchema, RepoListResultSchema, RepoTreeInputSchema } from "../contracts/repo.contract.js";
import { SearchInputSchema, SearchResponseSchema } from "../contracts/search.contract.js";
import { SemanticReviewInputSchema, SemanticReviewResultSchema } from "../contracts/semantic-review.contract.js";
import { ShipReviewResultSchema, ShipReviewToolInputSchema } from "../contracts/ship-review.contract.js";
import { SymbolContextInputSchema, SymbolContextResultSchema } from "../contracts/symbol-context.contract.js";
import { TaskInventoryInputSchema, TaskInventoryResultSchema } from "../contracts/task.contract.js";
import { RepoTreeResultSchema } from "../contracts/tree.contract.js";
import { ValidateInputSchema, ValidateResultSchema } from "../contracts/validation.contract.js";
import { CurrentWorkSessionInputSchema, CurrentWorkSessionResultSchema, StartWorkSessionInputSchema, StartWorkSessionResultSchema, UpdateWorkSessionInputSchema, UpdateWorkSessionResultSchema } from "../contracts/work-session.contract.js";
import { WriteChangesInputSchema, WriteChangesResultSchema, WriteFileInputSchema, WriteFileResultSchema } from "../contracts/write.contract.js";

export type ToolContract = {
  input: z.ZodObject<z.ZodRawShape>;
  output: z.ZodObject<z.ZodRawShape>;
};

function taskAwareMutationInput(schema: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
  const commonShape = {
    operation_id: LifecycleOperationIdSchema.optional().describe("Required for task-scoped mutation; omitted only for backward-compatible base-repository calls."),
    expected_tree_sha: LifecycleGitObjectIdSchema.optional().describe("Required for task-scoped mutation and checked against the exact current task tree.")
  };
  if ("expected_head_sha" in schema.shape) {
    return schema.safeExtend(commonShape);
  }
  return schema.safeExtend({
    ...commonShape,
    expected_head_sha: LifecycleGitObjectIdSchema.optional().describe("Required for task-scoped mutation and checked against the exact current task HEAD.")
  });
}

export const toolContracts = {
  repo_list_roots: {
    input: RepoInputSchema.omit({ repo_id: true }),
    output: RepoListResultSchema
  },
  repo_policy_explain: {
    input: PolicyExplainInputSchema,
    output: PolicyExplainResultSchema
  },
  repo_last_write: {
    input: LastWriteInputSchema,
    output: LastWriteResultSchema
  },
  repo_operation_ledger: {
    input: OperationLedgerInputSchema,
    output: OperationLedgerResultSchema
  },
  repo_tree: {
    input: RepoTreeInputSchema,
    output: RepoTreeResultSchema
  },
  repo_search: {
    input: SearchInputSchema,
    output: SearchResponseSchema
  },
  repo_fetch_file: {
    input: FetchFileInputSchema,
    output: FileContentSchema
  },
  repo_read_many: {
    input: ReadManyInputSchema,
    output: ReadManyResultSchema
  },
  repo_context_map: {
    input: ContextMapInputSchema,
    output: ContextMapResultSchema
  },
  repo_symbol_context: {
    input: SymbolContextInputSchema,
    output: SymbolContextResultSchema
  },
  repo_code_index: {
    input: taskAwareMutationInput(CodeIndexInputSchema),
    output: CodeIndexResultSchema
  },
  repo_failure_diagnose: {
    input: FailureDiagnoseInputSchema,
    output: FailureDiagnoseResultSchema
  },
  repo_semantic_review: {
    input: SemanticReviewInputSchema,
    output: SemanticReviewResultSchema
  },
  repo_ship_review: {
    input: ShipReviewToolInputSchema,
    output: ShipReviewResultSchema
  },
  repo_git_status: {
    input: GitStatusInputSchema,
    output: GitStatusResultSchema
  },
  repo_git_diff: {
    input: GitDiffInputSchema,
    output: GitDiffResultSchema
  },
  repo_git_review: {
    input: GitReviewInputSchema,
    output: GitReviewResultSchema
  },
  repo_git_restore_paths: {
    input: taskAwareMutationInput(GitRestorePathsInputSchema),
    output: GitRestorePathsResultSchema
  },
  repo_write_stage: {
    input: taskAwareMutationInput(GitStageInputSchema),
    output: GitStageResultSchema
  },
  repo_write_unstage: {
    input: taskAwareMutationInput(GitUnstageInputSchema),
    output: GitUnstageResultSchema
  },
  repo_write_commit: {
    input: taskAwareMutationInput(GitCommitInputSchema),
    output: GitCommitResultSchema
  },
  repo_write_stage_commit: {
    input: taskAwareMutationInput(GitStageCommitInputSchema),
    output: GitStageCommitResultSchema
  },
  repo_write_recover: {
    input: taskAwareMutationInput(GitRecoverInputSchema),
    output: GitRecoverResultSchema
  },
  repo_cleanup_paths: {
    input: taskAwareMutationInput(CleanupPathsInputSchema),
    output: CleanupPathsResultSchema
  },
  repo_project_brief: {
    input: ProjectBriefInputSchema,
    output: ProjectBriefResultSchema
  },
  repo_task_inventory: {
    input: TaskInventoryInputSchema,
    output: TaskInventoryResultSchema
  },
  repo_decision_memory: {
    input: DecisionLogInputSchema,
    output: DecisionLogResultSchema
  },
  repo_change_plan: {
    input: ChangePlanInputSchema,
    output: ChangePlanResultSchema
  },
  repo_prepare_codex_task: {
    input: DelegationTaskV3ToolInputSchema,
    output: DelegationPreparedResultV3Schema
  },
  repo_write_codex_task: {
    input: taskAwareMutationInput(DelegationTaskV3WriteToolInputSchema),
    output: DelegationWriteResultV3Schema
  },
  repo_agent_runs: {
    input: AgentRunsInputSchema,
    output: AgentRunsResultSchema
  },
  repo_write_agent_reply: {
    input: taskAwareMutationInput(AgentReplyInputSchema),
    output: AgentReplyResultSchema
  },
  repo_continue_agent_run: {
    input: AgentContinuationInputSchema,
    output: AgentContinuationResultSchema
  },
  repo_codex_review: {
    input: CodexReviewInputSchema,
    output: CodexReviewResultSchema
  },
  repo_write_codex_review: {
    input: taskAwareMutationInput(CodexReviewWriteInputSchema),
    output: CodexReviewWriteResultSchema
  },
  repo_write_integration_review: {
    input: taskAwareMutationInput(IntegrationReviewWriteInputSchema),
    output: IntegrationReviewWriteResultSchema
  },
  repo_finalize_codex_run: {
    input: RepoFinalizeCodexRunInputSchema,
    output: RepoFinalizeCodexRunResultSchema
  },
  repo_prepare_patchset: {
    input: taskAwareMutationInput(PatchsetPrepareInputSchema),
    output: PatchsetPrepareResultSchema
  },
  repo_apply_patchset: {
    input: taskAwareMutationInput(PatchsetApplyInputSchema),
    output: PatchsetApplyResultSchema
  },
  repo_review_patchset: {
    input: PatchsetReviewInputSchema,
    output: PatchsetReviewResultSchema
  },
  repo_rollback_patchset: {
    input: taskAwareMutationInput(PatchsetRollbackInputSchema),
    output: PatchsetRollbackResultSchema
  },
  repo_validate: {
    input: taskAwareMutationInput(ValidateInputSchema),
    output: ValidateResultSchema
  },
  repo_start_work_session: {
    input: taskAwareMutationInput(StartWorkSessionInputSchema),
    output: StartWorkSessionResultSchema
  },
  repo_update_work_session: {
    input: taskAwareMutationInput(UpdateWorkSessionInputSchema),
    output: UpdateWorkSessionResultSchema
  },
  repo_current_work_session: {
    input: CurrentWorkSessionInputSchema,
    output: CurrentWorkSessionResultSchema
  },
  repo_write_file: {
    input: taskAwareMutationInput(WriteFileInputSchema),
    output: WriteFileResultSchema
  },
  repo_write_changes: {
    input: taskAwareMutationInput(WriteChangesInputSchema),
    output: WriteChangesResultSchema
  },
  repo_write_handoff: {
    input: taskAwareMutationInput(HandoffInputSchema),
    output: HandoffResultSchema
  },
  repo_task_open: {
    input: RepoTaskOpenInputSchema,
    output: RepoTaskOpenResultSchema
  },
  repo_task_status: {
    input: RepoTaskStatusInputSchema,
    output: RepoTaskStatusResultSchema
  },
  repo_task_close: {
    input: RepoTaskCloseInputSchema,
    output: RepoTaskCloseResultSchema
  },
  repo_task_cleanup: {
    input: RepoTaskCleanupInputSchema,
    output: RepoTaskCleanupResultSchema
  },
  repo_artifact_read: {
    input: RepoArtifactReadInputSchema,
    output: RepoArtifactReadResultSchema
  },
  repo_run_fable_review: {
    input: RepoRunFableReviewInputSchema,
    output: RepoRunFableReviewResultSchema
  },
  repo_remote_status: {
    input: RepoRemoteStatusInputSchema,
    output: RepoRemoteStatusResultSchema
  },
  repo_write_push: {
    input: RepoWritePushInputSchema,
    output: RepoWritePushResultSchema
  },
  repo_pr_create_or_update: {
    input: RepoPrCreateOrUpdateInputSchema,
    output: RepoPrCreateOrUpdateResultSchema
  },
  repo_pr_status: {
    input: RepoPrStatusInputSchema,
    output: RepoPrStatusResultSchema
  },
  repo_pr_review_threads: {
    input: RepoPrReviewThreadsInputSchema,
    output: RepoPrReviewThreadsResultSchema
  },
  repo_write_pr_reply: {
    input: RepoWritePrReplyInputSchema,
    output: RepoWritePrReplyResultSchema
  },
  repo_write_pr_resolve_thread: {
    input: RepoWritePrResolveThreadInputSchema,
    output: RepoWritePrResolveThreadResultSchema
  },
  repo_ci_status: {
    input: RepoCiStatusInputSchema,
    output: RepoCiStatusResultSchema
  },
  repo_write_ci_retry_failed: {
    input: RepoWriteCiRetryFailedInputSchema,
    output: RepoWriteCiRetryFailedResultSchema
  },
  repo_merge_gate_prepare: {
    input: RepoMergeGatePrepareInputSchema,
    output: RepoMergeGatePrepareResultSchema
  },
  repo_write_merge: {
    input: RepoWriteMergeInputSchema,
    output: RepoWriteMergeResultSchema
  },
  repo_post_merge_readback: {
    input: RepoPostMergeReadbackInputSchema,
    output: RepoPostMergeReadbackResultSchema
  },
  repo_task_admission: {
    input: RepoTaskAdmissionInputSchema,
    output: RepoTaskAdmissionResultSchema
  }
} as const satisfies Record<string, ToolContract>;

export type ToolName = keyof typeof toolContracts;
