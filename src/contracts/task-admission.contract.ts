import { z } from "zod";
import {
  LifecycleGitObjectIdSchema,
  LifecycleRepoIdSchema,
  LifecycleSha256Schema,
  LifecycleTaskIdSchema
} from "./lifecycle.contract.js";

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
  ), "Invalid Git branch name.");
const BranchSlugSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const TaskAuthoritySchema = z.enum(["inspect", "implement", "ship"]);
const WarningsSchema = z.array(z.string().min(1).max(200)).max(100);

export const TaskAdmissionExpectedBindingSchema = z.object({
  base_branch: BranchNameSchema,
  base_commit_sha: LifecycleGitObjectIdSchema,
  base_tree_sha: LifecycleGitObjectIdSchema,
  authority: TaskAuthoritySchema,
  goal_sha256: LifecycleSha256Schema,
  branch_slug: BranchSlugSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema
}).strict();

export const RepoTaskAdmissionInputSchema = z.object({
  repo_id: LifecycleRepoIdSchema.describe("Approved base repository id whose active task set is inspected."),
  task_id: LifecycleTaskIdSchema.describe("Expected server-bound task id."),
  expected: TaskAdmissionExpectedBindingSchema.describe("Exact task binding and current Git state required for a matching admission.")
}).strict();

export const TaskAdmissionCandidateSchema = z.object({
  task_id: LifecycleTaskIdSchema,
  task_repo_id: LifecycleRepoIdSchema,
  base_repo_id: LifecycleRepoIdSchema,
  lifecycle: z.enum([
    "opening",
    "open",
    "closing",
    "closed",
    "cleanup_started",
    "cleanup_blocked",
    "cleaned",
    "recovery_required"
  ]),
  registration_state: z.enum(["pending", "registered", "unregistered", "unknown"]),
  authority: TaskAuthoritySchema,
  head_sha: LifecycleGitObjectIdSchema.nullable(),
  tree_sha: LifecycleGitObjectIdSchema.nullable(),
  binding_sha256: LifecycleSha256Schema,
  state_sha256: LifecycleSha256Schema
}).strict();

const MatchingTaskSchema = TaskAdmissionCandidateSchema.extend({
  lifecycle: z.literal("open"),
  registration_state: z.literal("registered"),
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema
}).strict();

export const TaskAdmissionConflictReasonSchema = z.enum([
  "OTHER_ACTIVE_TASK",
  "MULTIPLE_ACTIVE_TASKS",
  "TASK_NOT_READY",
  "TASK_REGISTRATION_MISMATCH",
  "TASK_BINDING_MISMATCH",
  "TASK_HEAD_TREE_MISMATCH",
  "TASK_READBACK_UNAVAILABLE"
]);

export const TaskAdmissionStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("task_absent"),
    absence_reason: z.enum(["NO_TASK", "TERMINAL_TASK_ID"]),
    active_task_count: z.literal(0),
    terminal_task: TaskAdmissionCandidateSchema.optional()
  }).strict(),
  z.object({
    status: z.literal("matching_active_task"),
    active_task_count: z.number().int().positive(),
    task: MatchingTaskSchema,
    worktree_clean: z.boolean()
  }).strict(),
  z.object({
    status: z.literal("conflicting_active_task"),
    active_task_count: z.number().int().positive(),
    conflict_reasons: z.array(TaskAdmissionConflictReasonSchema).min(1).max(20),
    observed_tasks: z.array(TaskAdmissionCandidateSchema).max(20),
    truncated: z.boolean()
  }).strict()
]);

export const RepoTaskAdmissionResultSchema = z.object({
  ok: z.literal(true),
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  expected_binding_sha256: LifecycleSha256Schema,
  lifecycle_available: z.boolean(),
  admission: TaskAdmissionStateSchema,
  warnings: WarningsSchema
}).strict();

export type TaskAdmissionExpectedBinding = z.infer<typeof TaskAdmissionExpectedBindingSchema>;
export type RepoTaskAdmissionInput = z.infer<typeof RepoTaskAdmissionInputSchema>;
export type RepoTaskAdmissionResult = z.infer<typeof RepoTaskAdmissionResultSchema>;
export type TaskAdmissionState = z.infer<typeof TaskAdmissionStateSchema>;
export type TaskAdmissionCandidate = z.infer<typeof TaskAdmissionCandidateSchema>;
export type TaskAdmissionConflictReason = z.infer<typeof TaskAdmissionConflictReasonSchema>;
