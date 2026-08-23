import { z } from "zod";

const identifier = (label: string, maxLength = 160, minLength = 1) => z.string()
  .min(minLength)
  .max(maxLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .describe(`${label} containing only stable identifier characters.`);

export const LifecycleRepoIdSchema = identifier("Approved repository id", 100);
export const LifecycleTaskIdSchema = identifier("Server-bound task id", 128);
export const LifecycleOperationIdSchema = identifier("Caller-generated operation id used for exact replay protection", 160, 8);
export const LifecycleGitObjectIdSchema = z.string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("Exact lowercase 40-character Git object id.");
export const LifecycleSha256Schema = z.string()
  .regex(/^[0-9a-f]{64}$/)
  .describe("Exact lowercase SHA-256 digest.");
export const LifecycleArtifactIdSchema = z.string()
  .regex(/^artifact_[A-Za-z0-9_-]{16,160}$/)
  .describe("Opaque server-issued artifact id; it is never a filesystem path.");
export const LifecycleMergeManifestIdSchema = z.string()
  .regex(/^merge_manifest_[A-Za-z0-9_-]{16,160}$/)
  .describe("Opaque server-issued merge manifest id.");
export const LifecycleApprovalIdSchema = z.string()
  .regex(/^merge_approval_[A-Za-z0-9_-]{16,160}$/)
  .describe("Opaque owner-CLI-issued one-time merge approval id.");

const TimestampSchema = z.string().datetime().describe("RFC 3339 timestamp recorded by the server.");
const WarningsSchema = z.array(z.string()).max(100).describe("Non-fatal stable warning codes.");
const Base64Schema = z.string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .describe("Canonical base64-encoded bytes.");
const BranchNameSchema = z.string()
  .min(1)
  .max(200)
  .refine((value) => (
    !value.startsWith("-")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !/[~^:?*[\\\s]/u.test(value)
  ), "Invalid Git branch name.")
  .describe("Exact Git branch name without ref syntax, traversal, whitespace, or shell characters.");
const BranchSlugSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("Lowercase task branch slug; the server derives the full task branch name.");
const PullRequestNumberSchema = z.number().int().positive().describe("GitHub pull request number bound to the task branch.");
const GitHubNodeIdSchema = z.string().min(1).max(200).describe("Opaque GitHub node id returned by the adapter.");
const GitHubRunIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).describe("Exact decimal GitHub Actions run id.");

const TaskIdentityShape = {
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema
};

const ExpectedTaskStateShape = {
  ...TaskIdentityShape,
  expected_head_sha: LifecycleGitObjectIdSchema.describe("Exact task-branch HEAD expected before the operation or external contact."),
  expected_tree_sha: LifecycleGitObjectIdSchema.describe("Exact task-branch tree expected before the operation or external contact.")
};

const OperationTaskStateShape = {
  operation_id: LifecycleOperationIdSchema,
  ...ExpectedTaskStateShape
};

export const LifecycleTaskBindingSchema = z.object({
  repo_id: LifecycleRepoIdSchema,
  base_repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  authority: z.enum(["inspect", "implement", "ship"]).describe("Maximum authority bound when the task was opened."),
  goal: z.string().min(1).max(4_000).describe("Exact task goal bound at open time."),
  base_branch: BranchNameSchema.describe("Base branch bound at open time."),
  base_commit_sha: LifecycleGitObjectIdSchema.describe("Base commit bound at open time."),
  base_tree_sha: LifecycleGitObjectIdSchema.describe("Base tree bound at open time."),
  branch_slug: BranchSlugSchema,
  task_branch: BranchNameSchema.describe("Exact server-owned task branch derived from the task binding."),
  head_sha: LifecycleGitObjectIdSchema.describe("Current exact task-branch HEAD."),
  tree_sha: LifecycleGitObjectIdSchema.describe("Current exact task-branch tree."),
  state: z.enum([
    "opening",
    "open",
    "closing",
    "closed",
    "cleanup_started",
    "cleanup_blocked",
    "cleaned",
    "recovery_required"
  ]).describe("Current durable local task lifecycle state."),
  opened_at: TimestampSchema,
  closed_at: TimestampSchema.optional(),
  cleaned_at: TimestampSchema.optional()
}).strict().describe("Complete server-owned local task binding.");

export const LifecycleArtifactRefSchema = z.object({
  artifact_id: LifecycleArtifactIdSchema,
  kind: z.enum([
    "task_manifest",
    "operation_receipt",
    "validation_log",
    "large_diff",
    "remote_observation",
    "push_receipt",
    "pull_request",
    "review_evidence",
    "ci_evidence",
    "merge_gate_evidence",
    "merge_receipt",
    "post_merge_evidence"
  ]).describe("Stable artifact category."),
  media_type: z.string().min(1).max(200).describe("IANA media type for the opaque artifact bytes."),
  byte_length: z.number().int().nonnegative().describe("Total artifact byte length."),
  sha256: LifecycleSha256Schema,
  created_at: TimestampSchema
}).strict().describe("Content-free reference to a server-owned lifecycle artifact.");

export const RepoTaskOpenInputSchema = z.object({
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema.describe("Approved base repository id bound to the task."),
  task_id: LifecycleTaskIdSchema,
  base_branch: BranchNameSchema,
  base_commit_sha: LifecycleGitObjectIdSchema,
  base_tree_sha: LifecycleGitObjectIdSchema,
  authority: z.enum(["inspect", "implement", "ship"]).describe("Maximum task authority; it never grants credentials or owner-only approval."),
  goal: z.string().min(1).max(4_000).describe("Exact user goal bound to the task."),
  branch_slug: BranchSlugSchema
}).strict();

export const RepoTaskOpenResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  task: LifecycleTaskBindingSchema,
  artifact: LifecycleArtifactRefSchema,
  created: z.boolean().describe("True only when this operation created the task; false for an exact idempotent replay."),
  warnings: WarningsSchema
}).strict();

export const RepoTaskStatusInputSchema = z.object(TaskIdentityShape).strict();

export const RepoTaskStatusResultSchema = z.object({
  ok: z.literal(true),
  task: LifecycleTaskBindingSchema,
  artifacts: z.array(LifecycleArtifactRefSchema).max(200),
  last_operation_id: LifecycleOperationIdSchema.optional(),
  cleanup_eligible: z.boolean().describe("Whether current server state admits task cleanup."),
  warnings: WarningsSchema
}).strict();

export const RepoTaskCloseInputSchema = z.object({
  ...OperationTaskStateShape,
  outcome: z.enum(["completed", "blocked", "abandoned", "superseded"]).describe("Exact terminal task outcome recorded locally."),
  summary: z.string().min(1).max(2_000).describe("Short final task summary stored with the close receipt.")
}).strict();

export const RepoTaskCloseResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  task: LifecycleTaskBindingSchema,
  outcome: z.enum(["completed", "blocked", "abandoned", "superseded"]),
  artifact: LifecycleArtifactRefSchema,
  changed: z.boolean().describe("True only when this operation changed task state."),
  warnings: WarningsSchema
}).strict();

export const RepoTaskCleanupInputSchema = z.object({
  ...OperationTaskStateShape,
  cleanup_scope: z.enum(["workspace_only", "workspace_and_artifacts"]).describe("Exact server-owned task resources eligible for deletion.")
}).strict();

export const RepoTaskCleanupResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema,
  state: z.literal("cleaned"),
  workspace_removed: z.boolean(),
  artifacts_removed: z.number().int().nonnegative(),
  changed: z.boolean().describe("True only when this operation deleted eligible task resources."),
  artifact: LifecycleArtifactRefSchema.describe("Durable cleanup receipt retained outside the deleted task artifact set."),
  warnings: WarningsSchema
}).strict();

export const RepoArtifactReadInputSchema = z.object({
  repo_id: LifecycleRepoIdSchema,
  artifact_id: LifecycleArtifactIdSchema,
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("Zero-based byte offset into the opaque artifact."),
  length: z.number().int().min(1).max(65_536).describe("Requested byte count, bounded to at most 65536 bytes.")
}).strict();

export const RepoArtifactReadResultSchema = z.object({
  ok: z.literal(true),
  repo_id: LifecycleRepoIdSchema,
  artifact_id: LifecycleArtifactIdSchema,
  media_type: z.string().min(1).max(200),
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(0).max(65_536).describe("Actual bytes returned."),
  total_length: z.number().int().nonnegative(),
  data_base64: Base64Schema.describe("Base64-encoded opaque artifact byte window."),
  next_offset: z.number().int().nonnegative().optional(),
  eof: z.boolean(),
  sha256: LifecycleSha256Schema,
  warnings: WarningsSchema
}).strict();

const RemoteRefSchema = z.object({
  name: BranchNameSchema,
  exists: z.boolean(),
  head_sha: LifecycleGitObjectIdSchema.optional(),
  tree_sha: LifecycleGitObjectIdSchema.optional()
}).strict().superRefine((value, context) => {
  const hasExactObject = value.head_sha !== undefined && value.tree_sha !== undefined;
  if (value.exists !== hasExactObject) {
    context.addIssue({ code: "custom", path: ["head_sha"], message: "Existing refs require exact head and tree ids; absent refs cannot include them." });
  }
});

export const RepoRemoteStatusInputSchema = z.object(OperationTaskStateShape).strict();

export const RepoRemoteStatusResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  local_head_sha: LifecycleGitObjectIdSchema,
  local_tree_sha: LifecycleGitObjectIdSchema,
  default_branch: RemoteRefSchema,
  task_branch: RemoteRefSchema,
  relationship: z.enum(["absent", "equal", "ahead", "behind", "diverged"]).describe("Task branch relationship to the exact local task HEAD."),
  observed_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

const PushContactStateSchema = z.object({
  pre_contact_recorded: z.literal(true),
  post_contact_recorded: z.literal(true),
  effect_state: z.enum(["no_change", "pushed", "queryable_effect"]).describe("Durably classified push effect after remote read-back."),
  recorded_at: TimestampSchema
}).strict();

export const RepoWritePushInputSchema = z.object(OperationTaskStateShape).strict();

export const RepoWritePushResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  task_branch: BranchNameSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema,
  remote_before: RemoteRefSchema,
  remote_after: RemoteRefSchema,
  fast_forward_only: z.literal(true),
  force_used: z.literal(false),
  contact: PushContactStateSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

const PullRequestSchema = z.object({
  number: PullRequestNumberSchema,
  url: z.string().url().describe("Canonical GitHub pull request URL."),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  title: z.string().min(1).max(256),
  base_branch: BranchNameSchema,
  head_branch: BranchNameSchema,
  head_sha: LifecycleGitObjectIdSchema,
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  updated_at: TimestampSchema
}).strict();

export const RepoPrCreateOrUpdateInputSchema = z.object({
  ...OperationTaskStateShape,
  title: z.string().min(1).max(256).describe("Exact pull request title."),
  body: z.string().max(65_536).describe("Exact pull request body."),
  draft: z.literal(true).describe("Creation and update are admitted only while the task pull request remains Draft.")
}).strict();

const DraftPullRequestSchema = PullRequestSchema.extend({
  draft: z.literal(true).describe("The create-or-update boundary always leaves the pull request in Draft state.")
}).strict();

export const RepoPrCreateOrUpdateResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  action: z.enum(["created", "updated", "no_change"]),
  pull_request: DraftPullRequestSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export const RepoPrStatusInputSchema = z.object(OperationTaskStateShape).strict();

export const RepoPrStatusResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  pull_request: PullRequestSchema.nullable(),
  observed_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

const ReviewCommentSchema = z.object({
  comment_id: GitHubNodeIdSchema,
  author: z.string().min(1).max(200),
  body_excerpt: z.string().max(4_096).describe("Bounded comment excerpt; the complete snapshot is available through the result artifact."),
  body_truncated: z.boolean(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  url: z.string().url()
}).strict();

const ReviewThreadSchema = z.object({
  thread_id: GitHubNodeIdSchema,
  path: z.string().min(1).max(1_024).describe("Repo-relative review location returned by GitHub."),
  line: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  resolved: z.boolean(),
  outdated: z.boolean(),
  comments: z.array(ReviewCommentSchema).max(100),
  updated_at: TimestampSchema
}).strict();

export const RepoPrReviewThreadsInputSchema = z.object({
  ...OperationTaskStateShape,
  cursor: z.string().min(1).max(1_024).optional().describe("Opaque GitHub pagination cursor from the prior result."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum review threads to return; server default applies when omitted.")
}).strict();

export const RepoPrReviewThreadsResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  pull_request_number: PullRequestNumberSchema,
  threads: z.array(ReviewThreadSchema).max(100),
  next_cursor: z.string().min(1).max(1_024).optional(),
  truncated: z.boolean(),
  observed_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export const RepoWritePrReplyInputSchema = z.object({
  ...OperationTaskStateShape,
  thread_id: GitHubNodeIdSchema,
  body: z.string().min(1).max(65_536).describe("Exact reply body posted to the bound review thread.")
}).strict();

export const RepoWritePrReplyResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  pull_request_number: PullRequestNumberSchema,
  thread_id: GitHubNodeIdSchema,
  comment: ReviewCommentSchema,
  created: z.boolean().describe("True only when this operation created the reply; false for an exact idempotent replay."),
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export const RepoWritePrResolveThreadInputSchema = z.object({
  ...OperationTaskStateShape,
  thread_id: GitHubNodeIdSchema,
  expected_thread_updated_at: TimestampSchema.describe("Exact thread version observed before resolution.")
}).strict();

export const RepoWritePrResolveThreadResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  pull_request_number: PullRequestNumberSchema,
  thread_id: GitHubNodeIdSchema,
  resolved: z.literal(true),
  changed: z.boolean().describe("True only when this operation changed the thread to resolved."),
  updated_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

const CiCheckSchema = z.object({
  name: z.string().min(1).max(500),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]).nullable(),
  details_url: z.string().url().optional(),
  started_at: TimestampSchema.optional(),
  completed_at: TimestampSchema.optional()
}).strict();

const CiRunSchema = z.object({
  run_id: GitHubRunIdSchema,
  workflow_name: z.string().min(1).max(500),
  head_sha: LifecycleGitObjectIdSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]).nullable(),
  url: z.string().url(),
  checks: z.array(CiCheckSchema).max(500)
}).strict();

const CiStatusIdSchema = z.string()
  .regex(/^ci_status_[A-Za-z0-9_-]{16,160}$/)
  .describe("Opaque digest-bound CI status snapshot id.");

export const RepoCiStatusInputSchema = z.object(OperationTaskStateShape).strict();

export const RepoCiStatusResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  ci_status_id: CiStatusIdSchema,
  head_sha: LifecycleGitObjectIdSchema,
  overall: z.enum(["pending", "success", "failure", "no_runs"]),
  required_checks: z.array(z.object({
    key: z.string().min(1).max(500),
    kind: z.enum(["check_run", "commit_status"]),
    status: z.enum(["missing", "pending", "success", "failure"]),
    source_id: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),
    conclusion: z.string().min(1).max(100).optional()
  }).strict()).max(100),
  runs: z.array(CiRunSchema).max(100),
  observed_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export const RepoWriteCiRetryFailedInputSchema = z.object({
  ...OperationTaskStateShape,
  ci_status_id: CiStatusIdSchema,
  failed_run_ids: z.array(GitHubRunIdSchema).length(1).describe("The one exact failed workflow run from the bound CI status snapshot eligible for a transient retry.")
}).strict();

export const RepoWriteCiRetryFailedResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  ci_status_id: CiStatusIdSchema,
  retried_run_ids: z.array(GitHubRunIdSchema).max(20),
  skipped_run_ids: z.array(GitHubRunIdSchema).max(20),
  changed: z.boolean().describe("True only when this operation requested at least one new run attempt."),
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]).describe("Exact merge method bound into the manifest and owner approval.");

export const LifecycleMergeManifestSchema = z.object({
  manifest_id: LifecycleMergeManifestIdSchema,
  manifest_sha256: LifecycleSha256Schema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  repository_id: GitHubNodeIdSchema,
  repository_name_with_owner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pull_request_id: GitHubNodeIdSchema,
  pull_request_number: PullRequestNumberSchema,
  pull_request_state: z.literal("open"),
  pull_request_draft: z.literal(true),
  pull_request_mergeable: z.literal("mergeable"),
  base_branch: BranchNameSchema,
  base_sha: LifecycleGitObjectIdSchema,
  task_branch: BranchNameSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema,
  merge_method: MergeMethodSchema,
  remote_branch_retained: z.literal(true).describe("The merge gate never authorizes remote task-branch deletion."),
  required_run_ids: z.array(GitHubRunIdSchema).max(100),
  unresolved_thread_ids: z.array(GitHubNodeIdSchema).max(500),
  ci_status_id: CiStatusIdSchema,
  ci_evidence_sha256: LifecycleSha256Schema,
  validation_id: identifier("Exact validation evidence id", 200),
  validation_sha256: LifecycleSha256Schema,
  independent_review_id: identifier("Exact independent-review evidence id", 200),
  independent_review_sha256: LifecycleSha256Schema,
  independent_review_required: z.boolean(),
  material_finding_count: z.literal(0),
  unknown_external_effect_count: z.literal(0),
  post_merge_plan: z.object({
    readback_required: z.literal(true),
    retain_task_branch: z.literal(true),
    verify_base_contains_head: z.literal(true)
  }).strict(),
  prepared_at: TimestampSchema,
  expires_at: TimestampSchema
}).strict().describe("Exact read-only merge manifest eligible for owner CLI approval.");

export const RepoMergeGatePrepareInputSchema = z.object(OperationTaskStateShape).strict()
  .describe("Prepare a gate using only the owner-registered merge method and mandatory remote branch retention policy.");

const MergeGateBlockerSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(1_000)
}).strict();

export const RepoMergeGatePrepareResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  eligible: z.boolean(),
  blockers: z.array(MergeGateBlockerSchema).max(100),
  manifest: LifecycleMergeManifestSchema.nullable(),
  approval_surface: z.literal("owner_cli"),
  approval_command: z.string().regex(/^chat-pro-repo approve-merge --gate-id merge_manifest_[A-Za-z0-9_-]{16,160}$/).nullable(),
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict().superRefine((value, context) => {
  if (value.eligible !== (value.manifest !== null)) {
    context.addIssue({ code: "custom", path: ["manifest"], message: "Eligible merge preparation must return a manifest and blocked preparation must not." });
  }
  if (value.eligible === (value.blockers.length > 0)) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "Eligible merge preparation cannot contain blockers and blocked preparation must contain at least one." });
  }
  if (value.eligible !== (value.approval_command !== null)) {
    context.addIssue({ code: "custom", path: ["approval_command"], message: "Eligible merge preparation must return the exact owner CLI command and blocked preparation must not." });
  }
});

export const RepoWriteMergeInputSchema = z.object({
  ...OperationTaskStateShape,
  manifest_id: LifecycleMergeManifestIdSchema,
  manifest_sha256: LifecycleSha256Schema,
  approval_id: LifecycleApprovalIdSchema
}).strict();

export const RepoWriteMergeResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  manifest_id: LifecycleMergeManifestIdSchema,
  manifest_sha256: LifecycleSha256Schema,
  approval_id: LifecycleApprovalIdSchema,
  approval_consumed: z.literal(true),
  pull_request_number: PullRequestNumberSchema,
  merge_method: MergeMethodSchema,
  effect: z.enum(["merged", "already_merged"]),
  merged_head_sha: LifecycleGitObjectIdSchema,
  merge_commit_sha: LifecycleGitObjectIdSchema,
  merged_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export const RepoPostMergeReadbackInputSchema = z.object({
  ...OperationTaskStateShape,
  merge_operation_id: LifecycleOperationIdSchema.describe("Exact completed merge operation whose remote effect must be read back.")
}).strict();

export const RepoPostMergeReadbackResultSchema = z.object({
  ok: z.literal(true),
  operation_id: LifecycleOperationIdSchema,
  merge_operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  pull_request_number: PullRequestNumberSchema,
  pull_request_state: z.literal("merged"),
  merged_head_sha: LifecycleGitObjectIdSchema,
  merge_commit_sha: LifecycleGitObjectIdSchema,
  base_branch: RemoteRefSchema,
  task_branch: RemoteRefSchema,
  readback_state: z.enum(["confirmed", "incomplete"]),
  observed_at: TimestampSchema,
  artifact: LifecycleArtifactRefSchema,
  warnings: WarningsSchema
}).strict();

export type RepoTaskOpenInput = z.infer<typeof RepoTaskOpenInputSchema>;
export type RepoTaskOpenResult = z.infer<typeof RepoTaskOpenResultSchema>;
export type RepoTaskStatusInput = z.infer<typeof RepoTaskStatusInputSchema>;
export type RepoTaskStatusResult = z.infer<typeof RepoTaskStatusResultSchema>;
export type RepoTaskCloseInput = z.infer<typeof RepoTaskCloseInputSchema>;
export type RepoTaskCloseResult = z.infer<typeof RepoTaskCloseResultSchema>;
export type RepoTaskCleanupInput = z.infer<typeof RepoTaskCleanupInputSchema>;
export type RepoTaskCleanupResult = z.infer<typeof RepoTaskCleanupResultSchema>;
export type RepoArtifactReadInput = z.infer<typeof RepoArtifactReadInputSchema>;
export type RepoArtifactReadResult = z.infer<typeof RepoArtifactReadResultSchema>;
export type RepoRemoteStatusInput = z.infer<typeof RepoRemoteStatusInputSchema>;
export type RepoRemoteStatusResult = z.infer<typeof RepoRemoteStatusResultSchema>;
export type RepoWritePushInput = z.infer<typeof RepoWritePushInputSchema>;
export type RepoWritePushResult = z.infer<typeof RepoWritePushResultSchema>;
export type RepoPrCreateOrUpdateInput = z.infer<typeof RepoPrCreateOrUpdateInputSchema>;
export type RepoPrCreateOrUpdateResult = z.infer<typeof RepoPrCreateOrUpdateResultSchema>;
export type RepoPrStatusInput = z.infer<typeof RepoPrStatusInputSchema>;
export type RepoPrStatusResult = z.infer<typeof RepoPrStatusResultSchema>;
export type RepoPrReviewThreadsInput = z.infer<typeof RepoPrReviewThreadsInputSchema>;
export type RepoPrReviewThreadsResult = z.infer<typeof RepoPrReviewThreadsResultSchema>;
export type RepoWritePrReplyInput = z.infer<typeof RepoWritePrReplyInputSchema>;
export type RepoWritePrReplyResult = z.infer<typeof RepoWritePrReplyResultSchema>;
export type RepoWritePrResolveThreadInput = z.infer<typeof RepoWritePrResolveThreadInputSchema>;
export type RepoWritePrResolveThreadResult = z.infer<typeof RepoWritePrResolveThreadResultSchema>;
export type RepoCiStatusInput = z.infer<typeof RepoCiStatusInputSchema>;
export type RepoCiStatusResult = z.infer<typeof RepoCiStatusResultSchema>;
export type RepoWriteCiRetryFailedInput = z.infer<typeof RepoWriteCiRetryFailedInputSchema>;
export type RepoWriteCiRetryFailedResult = z.infer<typeof RepoWriteCiRetryFailedResultSchema>;
export type RepoMergeGatePrepareInput = z.infer<typeof RepoMergeGatePrepareInputSchema>;
export type RepoMergeGatePrepareResult = z.infer<typeof RepoMergeGatePrepareResultSchema>;
export type RepoWriteMergeInput = z.infer<typeof RepoWriteMergeInputSchema>;
export type RepoWriteMergeResult = z.infer<typeof RepoWriteMergeResultSchema>;
export type RepoPostMergeReadbackInput = z.infer<typeof RepoPostMergeReadbackInputSchema>;
export type RepoPostMergeReadbackResult = z.infer<typeof RepoPostMergeReadbackResultSchema>;
