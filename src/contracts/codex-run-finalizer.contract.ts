import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";

const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const RepositoryPathSchema = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => (
    !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  ), "Path must be a safe repository-relative path.");
const BranchNameSchema = z.string()
  .min(1)
  .max(200)
  .refine((value) => (
    !/[\0\r\n\s~^:?*[\\]/.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
  ), "Branch name is invalid.");
const RemoteNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const RefNameSchema = z.string()
  .min(6)
  .max(300)
  .refine((value) => value.startsWith("refs/") && !/[\0\r\n\s~^:?*[\\]/.test(value) && !value.includes(".."));
const OperationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const BoundedTextSchema = z.string().min(1).max(2_000).refine((value) => !value.includes("\0"));
const SingleLineTextSchema = z.string().min(1).max(500).refine((value) => !/[\0\r\n]/.test(value));
const CommitMessageSchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/.test(value) && !/(?:&&|\|\||;|`|\$\(|<|>)/.test(value));
const TerminalMarkerSchema = z.string()
  .min(3)
  .max(500)
  .regex(/^[A-Z][A-Z0-9_.-]{0,79}=[A-Za-z0-9_./:@+,-]{1,400}$/);

export const CodexRunFinalizerChangedFileSchema = z.object({
  path: RepositoryPathSchema,
  sha256: Sha256Schema
}).strict();

export const CodexRunFinalizerCriterionEvidenceSchema = z.object({
  id: z.string().regex(/^TAC-[1-9][0-9]*$/),
  evidence: BoundedTextSchema
}).strict();

export const RepoFinalizeCodexRunInputSchema = z.object({
  operation_id: OperationIdSchema,
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  expected_prior_status: z.enum(["failed", "timed_out", "blocked_verification"]),
  expected_prior_status_revision: z.number().int().nonnegative(),
  expected_branch: BranchNameSchema,
  expected_head_sha: GitObjectIdSchema,
  expected_tree_sha: GitObjectIdSchema,
  expected_changed_files: z.array(CodexRunFinalizerChangedFileSchema).min(1).max(2_000),
  expected_tracked_path_count: z.number().int().positive().max(1_000_000),
  expected_remote_names: z.array(RemoteNameSchema).max(64).default([]),
  expected_absent_refs: z.array(RefNameSchema).max(64).default([]),
  commit_message: CommitMessageSchema,
  archive_label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  summary: BoundedTextSchema,
  change_reason: SingleLineTextSchema,
  technical_acceptance_evidence: z.array(CodexRunFinalizerCriterionEvidenceSchema).min(1).max(100),
  terminal_markers: z.array(TerminalMarkerSchema).max(64).default([]),
  dry_run: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  for (const [field, values] of [
    ["expected_changed_files", value.expected_changed_files.map(({ path }) => path)],
    ["expected_remote_names", value.expected_remote_names],
    ["expected_absent_refs", value.expected_absent_refs],
    ["technical_acceptance_evidence", value.technical_acceptance_evidence.map(({ id }) => id)],
    ["terminal_markers", value.terminal_markers]
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicates.` });
    }
  }
});

export const RepoFinalizeCodexRunValidationSchema = z.object({
  profile: z.literal("test"),
  command: z.string().min(1).max(2_000),
  tests_run: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  output_sha256: Sha256Schema,
  artifact_path: RepositoryPathSchema.nullable()
}).strict();

export const RepoFinalizeCodexRunArchiveSchema = z.object({
  path: z.string().min(1).max(1_024),
  byte_length: z.number().int().positive(),
  sha256: Sha256Schema,
  prefix: z.string().min(1).max(300),
  regular_file_count: z.number().int().positive()
}).strict();

export const RepoFinalizeCodexRunResultSchema = z.object({
  ok: z.literal(true),
  dry_run: z.boolean(),
  operation_id: OperationIdSchema,
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  status: z.enum(["validated", "committed"]),
  head_before: GitObjectIdSchema,
  head_after: GitObjectIdSchema.optional(),
  commit_sha: GitObjectIdSchema.optional(),
  changed_paths: z.array(RepositoryPathSchema).min(1).max(2_000),
  validation: RepoFinalizeCodexRunValidationSchema,
  archive: RepoFinalizeCodexRunArchiveSchema.nullable(),
  result_json_path: RepositoryPathSchema,
  runner_status_path: RepositoryPathSchema,
  warnings: z.array(z.string().min(1).max(500)).max(100)
}).strict();

export type RepoFinalizeCodexRunInput = z.infer<typeof RepoFinalizeCodexRunInputSchema>;
export type RepoFinalizeCodexRunResult = z.infer<typeof RepoFinalizeCodexRunResultSchema>;
