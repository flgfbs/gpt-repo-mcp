import { posix } from "node:path";
import { z } from "zod";
import { GitObjectIdSchema, Sha256Schema, TaskAuthoritySchema, TaskIdSchema, TaskRepoIdSchema } from "./contracts.js";
import { TaskArtifactIdSchema } from "./artifact-store.js";
import { digestRecord } from "./canonical-json.js";

const PortablePathSchema = z.string().min(1).max(1_024).refine(
  (value) => value !== "."
    && posix.normalize(value) === value
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !/(?:^|\/)\.\.(?:\/|$)/.test(value),
  "A canonical portable relative path is required."
);
const BoundedTextSchema = z.string().min(1).max(8_000).refine((value) => !value.includes("\0"));
const TimestampSchema = z.string().datetime();

const SemanticWorkerTaskBaseSchema = z.object({
  schema_version: z.literal(1),
  task_id: TaskIdSchema,
  repo_id: TaskRepoIdSchema,
  authority: TaskAuthoritySchema,
  goal: BoundedTextSchema,
  base: z.object({
    repo_id: z.string().min(1).max(200),
    branch: z.string().min(1).max(255).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value)),
    commit: GitObjectIdSchema,
    tree: GitObjectIdSchema
  }).strict(),
  constraints: z.array(z.string().min(1).max(1_000)).max(100),
  acceptance_criteria: z.array(z.string().min(1).max(1_000)).min(1).max(100),
  writable_paths: z.array(PortablePathSchema).max(200),
  created_at: TimestampSchema,
  task_sha256: Sha256Schema
}).strict();

export const SemanticWorkerTaskSchema = SemanticWorkerTaskBaseSchema.superRefine((value, context) => {
  if (semanticWorkerTaskSha256(value) !== value.task_sha256) {
    context.addIssue({ code: "custom", path: ["task_sha256"], message: "Task digest does not match canonical task content." });
  }
});

export const SemanticWorkerEditSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    path: PortablePathSchema,
    content_artifact_id: TaskArtifactIdSchema,
    content_sha256: Sha256Schema
  }).strict(),
  z.object({
    action: z.literal("replace"),
    path: PortablePathSchema,
    expected_sha256: Sha256Schema,
    content_artifact_id: TaskArtifactIdSchema,
    content_sha256: Sha256Schema
  }).strict(),
  z.object({
    action: z.literal("delete"),
    path: PortablePathSchema,
    expected_sha256: Sha256Schema
  }).strict()
]);

export const SemanticWorkerValidationSchema = z.object({
  validation_id: z.string().regex(/^validation-[a-z0-9][a-z0-9-]{0,63}$/),
  status: z.enum(["passed", "failed", "skipped", "blocked"]),
  command_argv: z.array(z.string().max(2_000).refine((value) => !value.includes("\0"))).min(1).max(64),
  exit_code: z.number().int().min(0).max(255).nullable(),
  evidence_artifact_id: TaskArtifactIdSchema.nullable(),
  evidence_sha256: Sha256Schema.nullable()
}).strict().superRefine((value, context) => {
  if ((value.evidence_artifact_id === null) !== (value.evidence_sha256 === null)) {
    context.addIssue({ code: "custom", path: ["evidence_artifact_id"], message: "Evidence artifact id and digest must be present together." });
  }
});

export const SemanticWorkerEvidenceSchema = z.object({
  evidence_id: z.string().regex(/^evidence-[a-z0-9][a-z0-9-]{0,63}$/),
  kind: z.enum(["analysis", "diff", "test", "diagnostic", "receipt"]),
  artifact_id: TaskArtifactIdSchema,
  artifact_sha256: Sha256Schema,
  summary: z.string().min(1).max(2_000)
}).strict();

const SemanticWorkerReceiptBaseSchema = z.object({
  schema_version: z.literal(1),
  task_id: TaskIdSchema,
  repo_id: TaskRepoIdSchema,
  outcome: z.enum(["completed", "blocked", "needs_input", "failed"]),
  summary: z.string().min(1).max(4_000),
  head_before: GitObjectIdSchema,
  head_after: GitObjectIdSchema.nullable(),
  edits: z.array(SemanticWorkerEditSchema).max(1_000),
  validations: z.array(SemanticWorkerValidationSchema).max(100),
  evidence: z.array(SemanticWorkerEvidenceSchema).max(200),
  completed_at: TimestampSchema,
  receipt_sha256: Sha256Schema
}).strict();

export const SemanticWorkerReceiptSchema = SemanticWorkerReceiptBaseSchema.superRefine((value, context) => {
  if (semanticWorkerReceiptSha256(value) !== value.receipt_sha256) {
    context.addIssue({ code: "custom", path: ["receipt_sha256"], message: "Receipt digest does not match canonical receipt content." });
  }
});

export function semanticWorkerTaskSha256(value: z.infer<typeof SemanticWorkerTaskBaseSchema>): string {
  return digestRecord(value as z.infer<typeof SemanticWorkerTaskBaseSchema> & Record<string, unknown>, "task_sha256");
}

export function semanticWorkerReceiptSha256(value: z.infer<typeof SemanticWorkerReceiptBaseSchema>): string {
  return digestRecord(value as z.infer<typeof SemanticWorkerReceiptBaseSchema> & Record<string, unknown>, "receipt_sha256");
}

export type SemanticWorkerTask = z.infer<typeof SemanticWorkerTaskSchema>;
export type SemanticWorkerEdit = z.infer<typeof SemanticWorkerEditSchema>;
export type SemanticWorkerValidation = z.infer<typeof SemanticWorkerValidationSchema>;
export type SemanticWorkerEvidence = z.infer<typeof SemanticWorkerEvidenceSchema>;
export type SemanticWorkerReceipt = z.infer<typeof SemanticWorkerReceiptSchema>;
