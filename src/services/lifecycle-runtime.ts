import type {
  RepoArtifactReadInput,
  RepoArtifactReadResult,
  RepoCiStatusInput,
  RepoCiStatusResult,
  RepoMergeGatePrepareInput,
  RepoMergeGatePrepareResult,
  RepoPostMergeReadbackInput,
  RepoPostMergeReadbackResult,
  RepoPrCreateOrUpdateInput,
  RepoPrCreateOrUpdateResult,
  RepoPrReviewThreadsInput,
  RepoPrReviewThreadsResult,
  RepoPrStatusInput,
  RepoPrStatusResult,
  RepoRemoteStatusInput,
  RepoRemoteStatusResult,
  RepoTaskCleanupInput,
  RepoTaskCleanupResult,
  RepoTaskCloseInput,
  RepoTaskCloseResult,
  RepoTaskOpenInput,
  RepoTaskOpenResult,
  RepoTaskStatusInput,
  RepoTaskStatusResult,
  RepoWriteCiRetryFailedInput,
  RepoWriteCiRetryFailedResult,
  RepoWriteMergeInput,
  RepoWriteMergeResult,
  RepoWritePrReplyInput,
  RepoWritePrReplyResult,
  RepoWritePrResolveThreadInput,
  RepoWritePrResolveThreadResult,
  RepoWritePushInput,
  RepoWritePushResult
} from "../contracts/lifecycle.contract.js";

/**
 * Strict construction seam for lifecycle tooling.
 *
 * Implementations own local task/artifact state, the fixed-argv Git push
 * boundary, and GitHub adapter orchestration. This interface deliberately
 * exposes no generic command, path, URL, repository, branch, or PR selector.
 */
export interface LifecycleRuntime {
  taskOpen(input: RepoTaskOpenInput): Promise<RepoTaskOpenResult>;
  taskStatus(input: RepoTaskStatusInput): Promise<RepoTaskStatusResult>;
  taskClose(input: RepoTaskCloseInput): Promise<RepoTaskCloseResult>;
  taskCleanup(input: RepoTaskCleanupInput): Promise<RepoTaskCleanupResult>;
  /**
   * Sole conversion seam from a public opaque artifact_id to internal artifact
   * store identity. Implementations must never interpret artifact_id as a path.
   */
  artifactRead(input: RepoArtifactReadInput): Promise<RepoArtifactReadResult>;
  remoteStatus(input: RepoRemoteStatusInput): Promise<RepoRemoteStatusResult>;
  writePush(input: RepoWritePushInput): Promise<RepoWritePushResult>;
  prCreateOrUpdate(input: RepoPrCreateOrUpdateInput): Promise<RepoPrCreateOrUpdateResult>;
  prStatus(input: RepoPrStatusInput): Promise<RepoPrStatusResult>;
  prReviewThreads(input: RepoPrReviewThreadsInput): Promise<RepoPrReviewThreadsResult>;
  writePrReply(input: RepoWritePrReplyInput): Promise<RepoWritePrReplyResult>;
  writePrResolveThread(input: RepoWritePrResolveThreadInput): Promise<RepoWritePrResolveThreadResult>;
  ciStatus(input: RepoCiStatusInput): Promise<RepoCiStatusResult>;
  writeCiRetryFailed(input: RepoWriteCiRetryFailedInput): Promise<RepoWriteCiRetryFailedResult>;
  mergeGatePrepare(input: RepoMergeGatePrepareInput): Promise<RepoMergeGatePrepareResult>;
  writeMerge(input: RepoWriteMergeInput): Promise<RepoWriteMergeResult>;
  postMergeReadback(input: RepoPostMergeReadbackInput): Promise<RepoPostMergeReadbackResult>;
}
