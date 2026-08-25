import { z } from "zod";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DEFAULT_OPERATIONS_POLICY, SHIP_VALIDATION_TEST_PATH_GLOBS } from "../policies/operations-defaults.js";
import { DEFAULT_WRITE_POLICY } from "../policies/write-defaults.js";

const PositiveIntSchema = z.number().int().positive();

export const DEFAULT_RUNTIME_ROOT = join(
  homedir(),
  "Library",
  "Application Support",
  "ChatProRepositoryMCP"
);

export const RepositoryAuthoritySchema = z.enum(["read", "write", "ship"]);
export const TaskAuthoritySchema = z.enum(["inspect", "implement", "ship"]);
export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export const TransientCiConclusionSchema = z.enum(["timed_out", "startup_failure", "stale"]);

export const RequiredCheckConfigSchema = z.union([
  z.string().min(1).max(256),
  z.object({
    kind: z.literal("check_run"),
    name: z.string().min(1).max(256),
    app_slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
  }).strict(),
  z.object({
    kind: z.literal("commit_status"),
    context: z.string().min(1).max(256)
  }).strict()
]);

export const CodeIntelligenceConfigSchema = z.object({
  provider: z.literal("codebase_memory"),
  executable: z.string().min(1).refine(isAbsolute, "code_intelligence.executable must be an absolute path"),
  query_timeout_ms: PositiveIntSchema.max(60_000).default(3_000),
  index_timeout_ms: PositiveIntSchema.max(3_600_000).default(1_800_000)
}).strict();

export const WritePolicyConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_WRITE_POLICY.enabled),
  allowed_globs: z.array(z.string()).default(DEFAULT_WRITE_POLICY.allowed_globs),
  denied_globs: z.array(z.string()).default(DEFAULT_WRITE_POLICY.denied_globs),
  max_bytes_per_write: PositiveIntSchema.default(DEFAULT_WRITE_POLICY.max_bytes_per_write)
}).strict();

const ValidationMakeProfileSchema = z.object({
  runner: z.literal("make"),
  target: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/)
}).strict();

const ValidationExecProfileSchema = z.object({
  runner: z.literal("exec"),
  executable: z.string().min(1).max(1_024).refine(isAbsolute, "validation executable must be an absolute path"),
  args: z.array(z.string().max(1_024)).max(64).default([]),
  cwd: z.string().min(1).max(512).regex(/^(?!\/|.*(?:^|\/)\.\.(?:\/|$)|.*\\).+$/).optional(),
  timeout_ms: PositiveIntSchema.max(3_600_000).optional(),
  env: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    z.string().max(2_048)
  ).optional()
}).strict();

export const ValidationProfileCommandSchema = z.union([
  ValidationMakeProfileSchema,
  ValidationExecProfileSchema
]);
export type ValidationProfileCommand = z.output<typeof ValidationProfileCommandSchema>;

const ValidationProfilesSchema = z.object({
  test: ValidationProfileCommandSchema.optional(),
  build: ValidationProfileCommandSchema.optional(),
  lint: ValidationProfileCommandSchema.optional(),
  typecheck: ValidationProfileCommandSchema.optional(),
  smoke: ValidationProfileCommandSchema.optional(),
  all: ValidationProfileCommandSchema.optional(),
  codegen: ValidationProfileCommandSchema.optional(),
  migration_preview: ValidationProfileCommandSchema.optional()
}).strict();

const OperationsPolicyConfigObjectSchema = z.object({
  enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.enabled),
  git_stage_enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.git_stage_enabled),
  git_commit_enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.git_commit_enabled),
  codex_run_finalize_enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.codex_run_finalize_enabled),
  validation_enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.validation_enabled),
  validation_test_path_globs: z.array(z.string()).default([]),
  validation_profiles: ValidationProfilesSchema.optional(),
  max_paths_per_operation: PositiveIntSchema.default(DEFAULT_OPERATIONS_POLICY.max_paths_per_operation),
  cleanup_enabled: z.boolean().default(DEFAULT_OPERATIONS_POLICY.cleanup_enabled),
  cleanup_allowed_globs: z.array(z.string()).default(DEFAULT_OPERATIONS_POLICY.cleanup_allowed_globs)
}).strict();

export const OperationsPolicyConfigSchema = z.preprocess(
  migrateLegacyShipValidation,
  OperationsPolicyConfigObjectSchema
);

export const LifecyclePolicyConfigSchema = z.object({
  kind: z.enum(["local", "github"]).default("github"),
  authority: RepositoryAuthoritySchema,
  remote_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  expected_remote_identity: z.string().min(1).max(1_024).optional(),
  allowed_base_branches: z.array(
    z.string().regex(/^(?!\/|.*(?:\.\.|@\{|\\|\s))[A-Za-z0-9._/-]{1,200}$/)
  ).min(1).max(16),
  worktree_root: z.string().min(1).refine(isAbsolute, "lifecycle.worktree_root must be an absolute path"),
  github_repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
  merge_method: MergeMethodSchema.optional(),
  required_checks: z.array(RequiredCheckConfigSchema).max(64).optional(),
  transient_ci_conclusions: z.array(TransientCiConclusionSchema).max(3).optional(),
  independent_review_required: z.boolean().optional(),
  require_clean_base: z.boolean().default(true),
  max_concurrent_tasks: PositiveIntSchema.max(64).default(8),
  cleanup: z.object({
    remove_worktree: z.boolean().default(true),
    delete_local_branch: z.boolean().default(true),
    require_terminal_task: z.boolean().default(true)
  }).strict().default({
    remove_worktree: true,
    delete_local_branch: true,
    require_terminal_task: true
  })
}).strict().superRefine((value, context) => {
  if (value.kind === "local") {
    for (const field of [
      "remote_name",
      "expected_remote_identity",
      "github_repository",
      "merge_method",
      "required_checks",
      "transient_ci_conclusions",
      "independent_review_required"
    ] as const) {
      if (value[field] !== undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Local lifecycle policy cannot configure ${field}.`
        });
      }
    }
    return;
  }
  for (const field of ["expected_remote_identity", "github_repository", "merge_method"] as const) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `GitHub lifecycle policy requires ${field}.`
      });
    }
  }
}).transform((value) => {
  const local = {
    authority: value.authority,
    allowed_base_branches: value.allowed_base_branches,
    worktree_root: value.worktree_root,
    require_clean_base: value.require_clean_base,
    max_concurrent_tasks: value.max_concurrent_tasks,
    cleanup: value.cleanup
  };
  if (value.kind === "local") {
    return { kind: "local" as const, ...local };
  }
  return {
    kind: "github" as const,
    ...local,
    remote_name: value.remote_name ?? "origin",
    expected_remote_identity: value.expected_remote_identity!,
    github_repository: value.github_repository!,
    merge_method: value.merge_method!,
    required_checks: value.required_checks ?? [],
    transient_ci_conclusions: value.transient_ci_conclusions ?? ["timed_out", "startup_failure", "stale"],
    independent_review_required: value.independent_review_required ?? false
  };
});

export const RepoConfigSchema = z.object({
  repo_id: z.string().min(1),
  display_name: z.string().min(1),
  root: z.string().min(1),
  allow_non_git: z.boolean().optional(),
  writes: WritePolicyConfigSchema.default(DEFAULT_WRITE_POLICY),
  operations: OperationsPolicyConfigSchema.default(DEFAULT_OPERATIONS_POLICY),
  lifecycle: LifecyclePolicyConfigSchema.optional()
}).strict();

const ProjectDirectoryNameSchema = z.string().min(1).max(255).refine(
  (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0"),
  "project root exclusions must be direct directory names"
);

export const ProjectRootConfigSchema = z.object({
  project_root_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
  root: z.string().min(1).refine(isAbsolute, "project_roots.root must be an absolute path"),
  repo_id_prefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/).optional(),
  exclude_directories: z.array(ProjectDirectoryNameSchema).max(256).default([])
}).strict();

export const LimitsConfigSchema = z.object({
  max_files: PositiveIntSchema.optional(),
  max_bytes_per_file: PositiveIntSchema.optional(),
  max_total_bytes: PositiveIntSchema.optional(),
  max_search_results: PositiveIntSchema.optional(),
  max_tree_entries: PositiveIntSchema.optional(),
  max_task_inventory_files: PositiveIntSchema.optional(),
  max_task_inventory_tree_pages: PositiveIntSchema.optional(),
  max_task_inventory_file_bytes: PositiveIntSchema.optional(),
  max_project_brief_doc_bytes: PositiveIntSchema.optional(),
  max_depth: PositiveIntSchema.optional(),
  max_diff_bytes: PositiveIntSchema.optional()
}).strict();

export const RepoReaderConfigSchema = z.object({
  repos: z.array(RepoConfigSchema).default([]),
  project_roots: z.array(ProjectRootConfigSchema).default([]),
  limits: LimitsConfigSchema.default({}),
  code_intelligence: CodeIntelligenceConfigSchema.optional(),
  runtime_root: z.string().min(1).refine(isAbsolute, "runtime_root must be an absolute path").default(DEFAULT_RUNTIME_ROOT)
}).strict();

export type WritePolicyConfigDocument = z.input<typeof WritePolicyConfigSchema>;
export type OperationsPolicyConfigDocument = z.input<typeof OperationsPolicyConfigObjectSchema>;
export type RepoConfig = {
  repo_id: string;
  display_name: string;
  root: string;
  allow_non_git?: boolean;
  writes?: WritePolicyConfigDocument;
  operations?: OperationsPolicyConfigDocument;
  lifecycle?: z.input<typeof LifecyclePolicyConfigSchema>;
};
export type ProjectRootConfig = z.input<typeof ProjectRootConfigSchema>;
export type RepoReaderConfig = {
  repos: RepoConfig[];
  project_roots?: ProjectRootConfig[];
  limits: z.input<typeof LimitsConfigSchema>;
  code_intelligence?: z.input<typeof CodeIntelligenceConfigSchema>;
  runtime_root?: string;
};
export type ParsedRepoConfig = z.output<typeof RepoConfigSchema>;
export type ParsedProjectRootConfig = z.output<typeof ProjectRootConfigSchema>;
export type ParsedRepoReaderConfig = z.output<typeof RepoReaderConfigSchema>;

function migrateLegacyShipValidation(value: unknown): unknown {
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, "validation_enabled")) {
    return value;
  }
  const shipLike = operationEnabled(value, "enabled")
    && operationEnabled(value, "git_stage_enabled")
    && operationEnabled(value, "git_commit_enabled")
    && operationEnabled(value, "cleanup_enabled");
  if (!shipLike) return value;
  const configuredGlobs = value.validation_test_path_globs;
  return {
    ...value,
    validation_enabled: true,
    validation_test_path_globs: Array.isArray(configuredGlobs) && configuredGlobs.length > 0
      ? configuredGlobs
      : SHIP_VALIDATION_TEST_PATH_GLOBS
  };
}

function operationEnabled(
  value: Record<string, unknown>,
  field: "enabled" | "git_stage_enabled" | "git_commit_enabled" | "cleanup_enabled"
): boolean {
  return (value[field] ?? DEFAULT_OPERATIONS_POLICY[field]) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
