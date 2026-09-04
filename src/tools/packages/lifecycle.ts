import {
  idempotentWriteAnnotations,
  openWorldMutationAnnotations,
  openWorldNonDestructiveMutationAnnotations,
  openWorldOneShotMutationAnnotations,
  openWorldReadOnlyAnnotations,
  readOnlyAnnotations,
  safeMutationAnnotations
} from "../annotations.js";
import {
  artifactReadHandler,
  ciStatusHandler,
  mergeGatePrepareHandler,
  postMergeReadbackHandler,
  prCreateOrUpdateHandler,
  prReviewThreadsHandler,
  prStatusHandler,
  remoteStatusHandler,
  runFableReviewHandler,
  taskCleanupHandler,
  taskAdmissionHandler,
  taskCloseHandler,
  taskOpenHandler,
  taskStatusHandler,
  writeCiRetryFailedHandler,
  writeMergeHandler,
  writePrReplyHandler,
  writePrResolveThreadHandler,
  writePushHandler
} from "../handlers/lifecycle.js";
import { defineTool } from "../tool-definition.js";

const lifecycleCapability = ["lifecycle"] as const;

export const lifecycleTools = [
  defineTool({ name: "repo_task_open", title: "Open repository task", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: safeMutationAnnotations, handler: taskOpenHandler }),
  defineTool({ name: "repo_task_status", title: "Read repository task status", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: readOnlyAnnotations, handler: taskStatusHandler }),
  defineTool({ name: "repo_task_close", title: "Close repository task", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: safeMutationAnnotations, handler: taskCloseHandler }),
  defineTool({ name: "repo_task_cleanup", title: "Clean repository task resources", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: idempotentWriteAnnotations, handler: taskCleanupHandler }),
  defineTool({ name: "repo_artifact_read", title: "Read lifecycle artifact", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: readOnlyAnnotations, handler: artifactReadHandler }),
  defineTool({ name: "repo_run_fable_review", title: "Run exact-head Fable review", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldOneShotMutationAnnotations, handler: runFableReviewHandler }),
  defineTool({ name: "repo_remote_status", title: "Read remote repository status", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: remoteStatusHandler }),
  defineTool({ name: "repo_write_push", title: "Push task branch", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldMutationAnnotations, handler: writePushHandler }),
  defineTool({ name: "repo_pr_create_or_update", title: "Create or update pull request", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldMutationAnnotations, handler: prCreateOrUpdateHandler }),
  defineTool({ name: "repo_pr_status", title: "Read pull request status", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: prStatusHandler }),
  defineTool({ name: "repo_pr_review_threads", title: "Read pull request review threads", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: prReviewThreadsHandler }),
  defineTool({ name: "repo_write_pr_reply", title: "Reply to pull request review", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldNonDestructiveMutationAnnotations, handler: writePrReplyHandler }),
  defineTool({ name: "repo_write_pr_resolve_thread", title: "Resolve pull request review thread", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldMutationAnnotations, handler: writePrResolveThreadHandler }),
  defineTool({ name: "repo_ci_status", title: "Read continuous integration status", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: ciStatusHandler }),
  defineTool({ name: "repo_write_ci_retry_failed", title: "Retry failed continuous integration runs", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldNonDestructiveMutationAnnotations, handler: writeCiRetryFailedHandler }),
  defineTool({ name: "repo_merge_gate_prepare", title: "Prepare exact merge gate", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: mergeGatePrepareHandler }),
  defineTool({ name: "repo_write_merge", title: "Merge with owner approval", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldMutationAnnotations, handler: writeMergeHandler }),
  defineTool({ name: "repo_post_merge_readback", title: "Read post-merge state", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: openWorldReadOnlyAnnotations, handler: postMergeReadbackHandler }),
  defineTool({ name: "repo_task_admission", title: "Read task admission", package: "lifecycle", tier: "specialist", requiredCapabilities: lifecycleCapability, annotations: readOnlyAnnotations, handler: taskAdmissionHandler })
];
