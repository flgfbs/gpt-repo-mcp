import { z } from "zod";
import { isAbsolute } from "node:path";

export const TaskIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const OperationIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const TaskRepoIdSchema = z.string().regex(/^task-[a-f0-9]{40}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const GitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const TaskAuthoritySchema = z.enum(["inspect", "implement", "ship"]);
export const TaskLifecycleSchema = z.enum([
  "OPENING",
  "OPEN",
  "CLOSING",
  "CLOSED",
  "CLEANUP_STARTED",
  "CLEANUP_BLOCKED",
  "CLEANED",
  "RECOVERY_REQUIRED"
]);
export const WorktreeStateSchema = z.enum(["ABSENT", "PRESENT", "DIRTY", "PARTIAL", "CONFLICT", "UNKNOWN"]);
export const BranchStateSchema = z.enum(["ABSENT", "PRESENT", "PRESERVED", "UNKNOWN"]);
export const RegistrationStateSchema = z.enum(["PENDING", "REGISTERED", "UNREGISTERED", "UNKNOWN"]);
export const TaskCloseDispositionSchema = z.enum(["completed", "blocked", "abandoned", "superseded"]);

export const OperationPhaseSchema = z.enum([
  "CREATED",
  "ADMITTED",
  "LOCAL_MUTATION_STARTED",
  "LOCAL_MUTATION_COMPLETE",
  "EXTERNAL_PRECONTACT",
  "EXTERNAL_CONTACTED",
  "EXTERNAL_SUCCEEDED",
  "FAILED_PRECONTACT",
  "FAILED_KNOWN_AFTER_CONTACT",
  "UNKNOWN_AFTER_CONTACT",
  "ROLLBACK_COMPLETE",
  "BLOCKED"
]);

export const ObservedEffectStateSchema = z.enum(["NOT_STARTED", "ABSENT", "PRESENT", "PARTIAL", "UNKNOWN"]);
export const OperationKindSchema = z.enum(["OPEN", "CLOSE", "CLEANUP"]);

const TimestampSchema = z.string().max(64).datetime();
const RuntimePathSchema = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes("\0"));
const BoundedTextSchema = z.string().min(1).max(8_000).refine((value) => !value.includes("\0"));

export const TaskStateSchema = z.object({
  schema_version: z.literal(1),
  task_id: TaskIdSchema,
  repo_id: TaskRepoIdSchema,
  base_repo_id: z.string().min(1).max(200),
  base_branch: z.string().min(1).max(255).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value)),
  base_commit: GitObjectIdSchema,
  base_tree: GitObjectIdSchema,
  authority: TaskAuthoritySchema,
  goal: BoundedTextSchema,
  branch_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/),
  server_branch: z.string().regex(/^chat-pro\/tasks\/[a-z0-9][a-z0-9-]{0,48}-[a-f0-9]{12}$/),
  worktree_path: RuntimePathSchema,
  lifecycle: TaskLifecycleSchema,
  worktree_state: WorktreeStateSchema,
  branch_state: BranchStateSchema,
  worktree_head: GitObjectIdSchema.nullable(),
  worktree_tree: GitObjectIdSchema.nullable(),
  registration_state: RegistrationStateSchema,
  close_disposition: TaskCloseDispositionSchema.nullable(),
  closed_at: TimestampSchema.nullable(),
  close_reason: z.string().min(1).max(1_000).optional(),
  cleanup_note: z.string().min(1).max(1_000).optional(),
  revision: z.number().int().nonnegative(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  state_sha256: Sha256Schema
}).strict().superRefine((value, context) => {
  const terminal = ["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "CLEANED"].includes(value.lifecycle);
  if (terminal && (value.close_disposition === null || value.closed_at === null)) {
    context.addIssue({ code: "custom", path: ["close_disposition"], message: "Terminal task state requires a durable close disposition and closed_at." });
  }
  if ((value.lifecycle === "OPEN" || value.lifecycle === "OPENING") && (value.close_disposition !== null || value.closed_at !== null)) {
    context.addIssue({ code: "custom", path: ["close_disposition"], message: "Open task state cannot contain terminal close fields." });
  }
  if (value.lifecycle === "CLOSING" && (value.close_disposition === null || value.closed_at !== null)) {
    context.addIssue({ code: "custom", path: ["close_disposition"], message: "Closing task state requires a disposition but cannot be marked closed yet." });
  }
  if (value.lifecycle === "CLEANED" && (value.worktree_state !== "ABSENT" || value.registration_state !== "UNREGISTERED")) {
    context.addIssue({ code: "custom", path: ["lifecycle"], message: "Cleaned task state requires an absent worktree and unregistered task repository." });
  }
});

export const OperationStateSchema = z.object({
  schema_version: z.literal(1),
  task_id: TaskIdSchema,
  operation_id: OperationIdSchema,
  kind: OperationKindSchema,
  request_sha256: Sha256Schema,
  phase: OperationPhaseSchema,
  effect_state: ObservedEffectStateSchema,
  revision: z.number().int().nonnegative(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  completed_at: TimestampSchema.nullable(),
  result_repo_id: TaskRepoIdSchema.nullable(),
  error_code: z.string().min(1).max(100).nullable(),
  error_message: z.string().min(1).max(1_000).nullable(),
  state_sha256: Sha256Schema
}).strict().superRefine((value, context) => {
  const terminal = [
    "LOCAL_MUTATION_COMPLETE",
    "EXTERNAL_SUCCEEDED",
    "FAILED_PRECONTACT",
    "FAILED_KNOWN_AFTER_CONTACT",
    "UNKNOWN_AFTER_CONTACT",
    "ROLLBACK_COMPLETE",
    "BLOCKED"
  ].includes(value.phase);
  if (terminal !== (value.completed_at !== null)) {
    context.addIssue({ code: "custom", path: ["completed_at"], message: "completed_at must match terminal operation phase state." });
  }
  if ((value.error_code === null) !== (value.error_message === null)) {
    context.addIssue({ code: "custom", path: ["error_code"], message: "Operation error code and message must be present together." });
  }
  if ((value.phase === "EXTERNAL_CONTACTED" || value.phase === "UNKNOWN_AFTER_CONTACT") && value.effect_state !== "UNKNOWN") {
    context.addIssue({ code: "custom", path: ["effect_state"], message: "Contacted operation with an unknown outcome must record UNKNOWN effect state." });
  }
  if (value.phase === "EXTERNAL_SUCCEEDED" && value.effect_state !== "PRESENT") {
    context.addIssue({ code: "custom", path: ["effect_state"], message: "Successful external effect must record PRESENT effect state." });
  }
});

export const TaskOpenInputSchema = z.object({
  operation_id: OperationIdSchema,
  task_id: TaskIdSchema,
  base_repo_id: z.string().min(1).max(200),
  base_branch: z.string().min(1).max(255).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value)),
  base_commit: GitObjectIdSchema,
  base_tree: GitObjectIdSchema,
  authority: TaskAuthoritySchema,
  goal: BoundedTextSchema,
  branch_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/)
}).strict();

export const TaskCloseInputSchema = z.object({
  operation_id: OperationIdSchema,
  task_id: TaskIdSchema,
  expected_head: GitObjectIdSchema.optional(),
  expected_tree: GitObjectIdSchema.optional(),
  disposition: TaskCloseDispositionSchema,
  reason: z.string().min(1).max(1_000).optional()
}).strict().superRefine(requireExpectedPair);

export const TaskCleanupInputSchema = z.object({
  operation_id: OperationIdSchema,
  task_id: TaskIdSchema,
  expected_head: GitObjectIdSchema.optional(),
  expected_tree: GitObjectIdSchema.optional(),
  cleanup_scope: z.enum(["workspace_only", "workspace_and_artifacts"]).default("workspace_only")
}).strict().superRefine(requireExpectedPair);

export type TaskState = z.infer<typeof TaskStateSchema>;
export type OperationState = z.infer<typeof OperationStateSchema>;
export type OperationPhase = z.infer<typeof OperationPhaseSchema>;
export type ObservedEffectState = z.infer<typeof ObservedEffectStateSchema>;
export type OperationKind = z.infer<typeof OperationKindSchema>;
export type TaskOpenInput = z.infer<typeof TaskOpenInputSchema>;
export type TaskCloseInput = z.infer<typeof TaskCloseInputSchema>;
export type TaskCleanupInput = z.input<typeof TaskCleanupInputSchema>;
export type TaskAuthority = z.infer<typeof TaskAuthoritySchema>;
export type TaskCloseDisposition = z.infer<typeof TaskCloseDispositionSchema>;

function requireExpectedPair(
  value: { expected_head?: string; expected_tree?: string },
  context: z.RefinementCtx
): void {
  if ((value.expected_head === undefined) !== (value.expected_tree === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["expected_head"],
      message: "expected_head and expected_tree must be provided together."
    });
  }
}
