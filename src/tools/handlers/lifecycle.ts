import type { RepoTaskAdmissionInput } from "../../contracts/task-admission.contract.js";
import type { RepoRunFableReviewInput } from "../../contracts/fable-review.contract.js";
import type {
  RepoArtifactReadInput,
  RepoCiStatusInput,
  RepoMergeGatePrepareInput,
  RepoPostMergeReadbackInput,
  RepoPrCreateOrUpdateInput,
  RepoPrReviewThreadsInput,
  RepoPrStatusInput,
  RepoRemoteStatusInput,
  RepoTaskCleanupInput,
  RepoTaskCloseInput,
  RepoTaskOpenInput,
  RepoTaskStatusInput,
  RepoWriteCiRetryFailedInput,
  RepoWriteMergeInput,
  RepoWritePrReplyInput,
  RepoWritePrResolveThreadInput,
  RepoWritePushInput
} from "../../contracts/lifecycle.contract.js";
import { RepoReaderError } from "../../runtime/errors.js";
import type { RuntimeContext } from "../../runtime/context.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { audit } from "../../runtime/telemetry.js";
import type { LifecycleRuntime } from "../../services/lifecycle-runtime.js";
import type { ManagedFableReviewRuntime } from "../../services/managed-fable-review-service.js";
import { safeTool, type ToolHandler } from "../handler-support.js";

type LifecycleRuntimeContext = RuntimeContext & { readonly lifecycle: LifecycleRuntime };
type FableReviewRuntimeContext = RuntimeContext & { readonly fableReviews: ManagedFableReviewRuntime };

// Runtime construction must add this dependency when the lifecycle services are integrated.
// Keeping the requirement structural here lets this bounded tool-surface slice compile without
// editing src/runtime/context.ts or weakening LifecycleRuntime's strict interface.
function assertLifecycleRuntime(context: RuntimeContext): asserts context is LifecycleRuntimeContext {
  if (!("lifecycle" in context) || typeof context.lifecycle !== "object" || context.lifecycle === null) {
    throw new RepoReaderError("INTERNAL_ERROR", "Lifecycle runtime is not configured.");
  }
}

function assertFableReviewRuntime(context: RuntimeContext): asserts context is FableReviewRuntimeContext {
  if (!("fableReviews" in context) || typeof context.fableReviews !== "object" || context.fableReviews === null) {
    throw new RepoReaderError("INTERNAL_ERROR", "Managed Fable review runtime is not configured.");
  }
}

export const taskOpenHandler: ToolHandler = async (input, context) => safeTool<RepoTaskOpenInput>("repo_task_open", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.taskOpen(args);
  audit({ tool: "repo_task_open", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Task ${args.task_id} is open at ${result.task.head_sha}.`);
});

export const taskStatusHandler: ToolHandler = async (input, context) => safeTool<RepoTaskStatusInput>("repo_task_status", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.taskStatus(args);
  audit({ tool: "repo_task_status", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Task ${args.task_id} is ${result.task.state}.`);
});

export const taskAdmissionHandler: ToolHandler = async (input, context) => safeTool<RepoTaskAdmissionInput>("repo_task_admission", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.taskAdmission(args);
  audit({ tool: "repo_task_admission", repo_id: args.repo_id, counts: { active_tasks: result.admission.active_task_count }, warnings: result.warnings });
  return createSuccessEnvelope(result, `Task admission is ${result.admission.status}.`);
});

export const taskCloseHandler: ToolHandler = async (input, context) => safeTool<RepoTaskCloseInput>("repo_task_close", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.taskClose(args);
  audit({ tool: "repo_task_close", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Task ${args.task_id} closed as ${result.outcome}.`);
});

export const taskCleanupHandler: ToolHandler = async (input, context) => safeTool<RepoTaskCleanupInput>("repo_task_cleanup", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.taskCleanup(args);
  audit({ tool: "repo_task_cleanup", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Cleaned server-owned resources for task ${args.task_id}.`);
});

export const artifactReadHandler: ToolHandler = async (input, context) => safeTool<RepoArtifactReadInput>("repo_artifact_read", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.artifactRead(args);
  audit({ tool: "repo_artifact_read", repo_id: args.repo_id, counts: { bytes: result.length }, truncated: !result.eof, warnings: result.warnings });
  return createSuccessEnvelope(result, `Read ${result.length} artifact bytes at offset ${result.offset}.`);
});

export const runFableReviewHandler: ToolHandler = async (input, context) => safeTool<RepoRunFableReviewInput>("repo_run_fable_review", input, async (args) => {
  assertFableReviewRuntime(context);
  const result = await context.fableReviews.run(args);
  audit({
    tool: "repo_run_fable_review",
    repo_id: args.repo_id,
    counts: { findings: result.review_result?.findings.length ?? 0 },
    warnings: result.warnings
  });
  return createSuccessEnvelope(
    result,
    `Fable review state is ${result.review_state}; provider contact is ${result.provider_contact}.`
  );
});

export const remoteStatusHandler: ToolHandler = async (input, context) => safeTool<RepoRemoteStatusInput>("repo_remote_status", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.remoteStatus(args);
  audit({ tool: "repo_remote_status", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Remote task branch relationship is ${result.relationship}.`);
});

export const writePushHandler: ToolHandler = async (input, context) => safeTool<RepoWritePushInput>("repo_write_push", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.writePush(args);
  audit({ tool: "repo_write_push", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Push effect is ${result.contact.effect_state}.`);
});

export const prCreateOrUpdateHandler: ToolHandler = async (input, context) => safeTool<RepoPrCreateOrUpdateInput>("repo_pr_create_or_update", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.prCreateOrUpdate(args);
  audit({ tool: "repo_pr_create_or_update", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Pull request ${result.pull_request.number} was ${result.action}.`);
});

export const prStatusHandler: ToolHandler = async (input, context) => safeTool<RepoPrStatusInput>("repo_pr_status", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.prStatus(args);
  audit({ tool: "repo_pr_status", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, result.pull_request ? `Pull request ${result.pull_request.number} is ${result.pull_request.state}.` : "No pull request is bound to the task.");
});

export const prReviewThreadsHandler: ToolHandler = async (input, context) => safeTool<RepoPrReviewThreadsInput>("repo_pr_review_threads", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.prReviewThreads(args);
  audit({ tool: "repo_pr_review_threads", repo_id: args.repo_id, counts: { threads: result.threads.length }, truncated: result.truncated, warnings: result.warnings });
  return createSuccessEnvelope(result, `Returned ${result.threads.length} review threads.`);
});

export const writePrReplyHandler: ToolHandler = async (input, context) => safeTool<RepoWritePrReplyInput>("repo_write_pr_reply", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.writePrReply(args);
  audit({ tool: "repo_write_pr_reply", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Reply recorded on review thread ${result.thread_id}.`);
});

export const writePrResolveThreadHandler: ToolHandler = async (input, context) => safeTool<RepoWritePrResolveThreadInput>("repo_write_pr_resolve_thread", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.writePrResolveThread(args);
  audit({ tool: "repo_write_pr_resolve_thread", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Review thread ${result.thread_id} is resolved.`);
});

export const ciStatusHandler: ToolHandler = async (input, context) => safeTool<RepoCiStatusInput>("repo_ci_status", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.ciStatus(args);
  audit({ tool: "repo_ci_status", repo_id: args.repo_id, counts: { runs: result.runs.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, `CI status is ${result.overall} across ${result.runs.length} runs.`);
});

export const writeCiRetryFailedHandler: ToolHandler = async (input, context) => safeTool<RepoWriteCiRetryFailedInput>("repo_write_ci_retry_failed", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.writeCiRetryFailed(args);
  audit({ tool: "repo_write_ci_retry_failed", repo_id: args.repo_id, counts: { retried: result.retried_run_ids.length, skipped: result.skipped_run_ids.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, `Requested retries for ${result.retried_run_ids.length} failed CI runs.`);
});

export const mergeGatePrepareHandler: ToolHandler = async (input, context) => safeTool<RepoMergeGatePrepareInput>("repo_merge_gate_prepare", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.mergeGatePrepare(args);
  audit({ tool: "repo_merge_gate_prepare", repo_id: args.repo_id, counts: { blockers: result.blockers.length }, warnings: result.warnings });
  return createSuccessEnvelope(result, result.eligible ? "Prepared an exact merge manifest for owner CLI approval." : `Merge gate has ${result.blockers.length} blockers.`);
});

export const writeMergeHandler: ToolHandler = async (input, context) => safeTool<RepoWriteMergeInput>("repo_write_merge", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.writeMerge(args);
  audit({ tool: "repo_write_merge", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Pull request ${result.pull_request_number} merge effect is ${result.effect}.`);
});

export const postMergeReadbackHandler: ToolHandler = async (input, context) => safeTool<RepoPostMergeReadbackInput>("repo_post_merge_readback", input, async (args) => {
  assertLifecycleRuntime(context);
  const result = await context.lifecycle.postMergeReadback(args);
  audit({ tool: "repo_post_merge_readback", repo_id: args.repo_id, warnings: result.warnings });
  return createSuccessEnvelope(result, `Post-merge read-back is ${result.readback_state}.`);
});
