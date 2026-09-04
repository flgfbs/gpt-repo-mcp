import { z } from "zod";
import {
  LifecycleArtifactIdSchema,
  LifecycleArtifactRefSchema,
  LifecycleGitObjectIdSchema,
  LifecycleOperationIdSchema,
  LifecycleRepoIdSchema,
  LifecycleSha256Schema,
  LifecycleTaskIdSchema
} from "./lifecycle.contract.js";

const ReviewPathSchema = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => {
    const segments = value.split("/");
    return (
      !value.startsWith("/")
      && !value.startsWith(":")
      && !value.endsWith("/")
      && !value.includes("\\")
      && !value.includes("\0")
      && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      && !value.startsWith(".git/")
      && !value.startsWith(".chatgpt/")
    );
  }, "Review paths must be canonical project-relative paths outside internal control roots.");

export const FableReviewScopeInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("all_changes")
  }).strict(),
  z.object({
    kind: z.literal("focused_paths"),
    paths: z.array(ReviewPathSchema).min(1).max(200)
  }).strict().superRefine((value, context) => {
    if (new Set(value.paths).size !== value.paths.length) {
      context.addIssue({ code: "custom", path: ["paths"], message: "Focused review paths must be unique." });
    }
    if ([...value.paths].sort((left, right) => left.localeCompare(right)).some((path, index) => path !== value.paths[index])) {
      context.addIssue({ code: "custom", path: ["paths"], message: "Focused review paths must be sorted canonically." });
    }
  })
]);

const FableReviewTargetSchema = z.object({
  base_commit_sha: LifecycleGitObjectIdSchema,
  base_tree_sha: LifecycleGitObjectIdSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema
}).strict();

const FableReviewScopeSchema = z.object({
  kind: z.enum(["all_changes", "focused_paths"]),
  paths: z.array(ReviewPathSchema).max(200),
  sha256: LifecycleSha256Schema
}).strict();

const FableReviewPacketSchema = z.object({
  sha256: LifecycleSha256Schema,
  body_sha256: LifecycleSha256Schema,
  byte_length: z.number().int().positive().max(32 * 1024 * 1024)
}).strict();

const FableFindingTextSchema = z.string().min(1).max(64 * 1024);
const FableReviewFindingSchema = z.object({
  finding_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  summary: FableFindingTextSchema,
  evidence: FableFindingTextSchema,
  impact: FableFindingTextSchema,
  uncertainty: FableFindingTextSchema,
  proposed_test: FableFindingTextSchema
}).strict();

export const FableReviewResultSchema = z.object({
  schema: z.literal("claude-review-router-findings.v1"),
  review_status: z.enum(["PASS", "REVISE", "BLOCK"]),
  summary: FableFindingTextSchema,
  findings: z.array(FableReviewFindingSchema).max(64)
}).strict().superRefine((value, context) => {
  if ((value.review_status === "PASS") !== (value.findings.length === 0)) {
    context.addIssue({ code: "custom", path: ["findings"], message: "PASS requires no findings; REVISE or BLOCK requires at least one finding." });
  }
  if (new Set(value.findings.map((finding) => finding.finding_id)).size !== value.findings.length) {
    context.addIssue({ code: "custom", path: ["findings"], message: "finding_id values must be unique." });
  }
});

const FableReviewLineageSchema = z.object({
  lineage_id: z.string().regex(/^fable_lineage_[a-f0-9]{32}$/),
  epoch_id: z.string().regex(/^fable_epoch_[a-f0-9]{32}$/),
  kind: z.enum(["initial", "focused_rereview"]),
  prior_review_artifact_id: LifecycleArtifactIdSchema.optional()
}).strict();

const FableReviewReceiptSchema = z.object({
  attempt_id: z.string().regex(/^[a-f0-9]{32}$/),
  receipt_sha256: LifecycleSha256Schema,
  response_sha256: LifecycleSha256Schema,
  response_utf8_bytes: z.number().int().positive().max(1024 * 1024),
  retained_read_back: z.literal(true)
}).strict();

export const RepoRunFableReviewInputSchema = z.object({
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema.describe("Exact active task repository id; base repositories are rejected."),
  task_id: LifecycleTaskIdSchema,
  expected_base_commit_sha: LifecycleGitObjectIdSchema,
  expected_base_tree_sha: LifecycleGitObjectIdSchema,
  expected_head_sha: LifecycleGitObjectIdSchema,
  expected_tree_sha: LifecycleGitObjectIdSchema,
  review_kind: z.enum(["initial", "focused_rereview"]),
  scope: FableReviewScopeInputSchema,
  prior_review_artifact_id: LifecycleArtifactIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.review_kind === "initial") {
    if (value.scope.kind !== "all_changes") {
      context.addIssue({ code: "custom", path: ["scope"], message: "Initial review must cover all exact task changes." });
    }
    if (value.prior_review_artifact_id !== undefined) {
      context.addIssue({ code: "custom", path: ["prior_review_artifact_id"], message: "Initial review cannot bind a prior review artifact." });
    }
  } else {
    if (value.scope.kind !== "focused_paths") {
      context.addIssue({ code: "custom", path: ["scope"], message: "Focused rereview requires explicit focused paths." });
    }
    if (value.prior_review_artifact_id === undefined) {
      context.addIssue({ code: "custom", path: ["prior_review_artifact_id"], message: "Focused rereview requires the retained prior review artifact." });
    }
  }
});

export const FableReviewEvidenceSchema = z.object({
  schema: z.literal("chat-pro-repository-managed-fable-review.v1"),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  review_state: z.enum(["failed_precontact", "review_completed", "contacted_incomplete", "unknown_effect"]),
  provider_contact: z.enum(["NO", "YES", "UNKNOWN"]),
  effect_disposition: z.enum([
    "NO_EXTERNAL_EFFECT",
    "VALID_REVIEW_RESULT",
    "ATTEMPT_EFFECT_ONLY",
    "PARTIAL_EXTERNAL_EFFECT",
    "UNKNOWN_EXTERNAL_EFFECT"
  ]),
  model_class: z.literal("FABLE"),
  reasoning: z.literal("MAX"),
  target: FableReviewTargetSchema,
  scope: FableReviewScopeSchema,
  packet: FableReviewPacketSchema.optional(),
  lineage: FableReviewLineageSchema.optional(),
  receipt: FableReviewReceiptSchema.optional(),
  review_result: FableReviewResultSchema.optional(),
  outcome_code: z.string().min(1).max(160).regex(/^[A-Z0-9][A-Z0-9._:-]*$/),
  retry_authorized: z.literal(false),
  fallback_authorized: z.literal(false),
  reroute_authorized: z.literal(false),
  continuation_authorized: z.literal(false),
  recorded_at: z.string().datetime()
}).strict().superRefine((value, context) => {
  const completed = value.review_state === "review_completed";
  if (completed !== (value.provider_contact === "YES" && value.effect_disposition === "VALID_REVIEW_RESULT")) {
    context.addIssue({ code: "custom", path: ["review_state"], message: "Completed review state must bind one contacted valid review result." });
  }
  if (completed !== (value.review_result !== undefined && value.receipt !== undefined)) {
    context.addIssue({ code: "custom", path: ["review_result"], message: "Completed review state requires the sanitized review and retained receipt evidence only." });
  }
  if (value.review_state === "failed_precontact" && (value.provider_contact !== "NO" || value.effect_disposition !== "NO_EXTERNAL_EFFECT")) {
    context.addIssue({ code: "custom", path: ["provider_contact"], message: "Precontact failure must record no provider contact and no external effect." });
  }
  if (value.review_state === "contacted_incomplete" && value.provider_contact !== "YES") {
    context.addIssue({ code: "custom", path: ["provider_contact"], message: "Contacted incomplete state must preserve provider_contact=YES." });
  }
  if (value.review_state === "unknown_effect" && (value.provider_contact !== "UNKNOWN" || value.effect_disposition !== "UNKNOWN_EXTERNAL_EFFECT")) {
    context.addIssue({ code: "custom", path: ["effect_disposition"], message: "Unknown effect state must remain unknown and fail closed." });
  }
});

export const RepoRunFableReviewResultSchema = FableReviewEvidenceSchema.safeExtend({
  ok: z.literal(true),
  artifact: LifecycleArtifactRefSchema.optional(),
  warnings: z.array(z.string().min(1).max(200)).max(100)
}).strict();

export type RepoRunFableReviewInput = z.infer<typeof RepoRunFableReviewInputSchema>;
export type RepoRunFableReviewResult = z.infer<typeof RepoRunFableReviewResultSchema>;
export type FableReviewEvidence = z.infer<typeof FableReviewEvidenceSchema>;
export type FableReviewResult = z.infer<typeof FableReviewResultSchema>;
export type FableReviewScopeInput = z.infer<typeof FableReviewScopeInputSchema>;
