import { readFileSync } from "node:fs";
import { RepoTaskAdmissionInputSchema, TaskAdmissionStateSchema } from "../src/contracts/task-admission.contract.js";
import { describe, expect, test } from "vitest";
import {
  RepoArtifactReadInputSchema,
  RepoMergeGatePrepareInputSchema,
  RepoMergeGatePrepareResultSchema,
  RepoTaskOpenInputSchema,
  RepoWriteMergeInputSchema,
  RepoWriteCiRetryFailedInputSchema,
  RepoWritePushInputSchema
} from "../src/contracts/lifecycle.contract.js";
import {
  idempotentWriteAnnotations,
  openWorldMutationAnnotations,
  openWorldNonDestructiveMutationAnnotations,
  openWorldOneShotMutationAnnotations,
  openWorldReadOnlyAnnotations,
  readOnlyAnnotations,
  safeMutationAnnotations
} from "../src/tools/annotations.js";
import { toolContracts, type ToolName } from "../src/tools/contracts.js";
import { CANONICAL_TOOL_ORDER, toolRegistry, toolsForPackage } from "../src/tools/registry.js";

const INHERITED_TOOL_ORDER = [
  "repo_list_roots",
  "repo_policy_explain",
  "repo_last_write",
  "repo_operation_ledger",
  "repo_tree",
  "repo_search",
  "repo_fetch_file",
  "repo_read_many",
  "repo_context_map",
  "repo_symbol_context",
  "repo_code_index",
  "repo_failure_diagnose",
  "repo_semantic_review",
  "repo_ship_review",
  "repo_git_status",
  "repo_git_diff",
  "repo_git_review",
  "repo_git_restore_paths",
  "repo_write_stage",
  "repo_write_unstage",
  "repo_write_commit",
  "repo_write_stage_commit",
  "repo_write_recover",
  "repo_cleanup_paths",
  "repo_project_brief",
  "repo_task_inventory",
  "repo_decision_memory",
  "repo_change_plan",
  "repo_prepare_codex_task",
  "repo_write_codex_task",
  "repo_agent_runs",
  "repo_write_agent_reply",
  "repo_codex_review",
  "repo_write_codex_review",
  "repo_write_integration_review",
  "repo_finalize_codex_run",
  "repo_prepare_patchset",
  "repo_apply_patchset",
  "repo_review_patchset",
  "repo_rollback_patchset",
  "repo_validate",
  "repo_start_work_session",
  "repo_update_work_session",
  "repo_current_work_session",
  "repo_write_file",
  "repo_write_changes",
  "repo_write_handoff",
  "repo_continue_agent_run"
] as const;

const LIFECYCLE_TOOL_ORDER = [
  "repo_task_open",
  "repo_task_status",
  "repo_task_close",
  "repo_task_cleanup",
  "repo_artifact_read",
  "repo_run_fable_review",
  "repo_remote_status",
  "repo_write_push",
  "repo_pr_create_or_update",
  "repo_pr_status",
  "repo_pr_review_threads",
  "repo_write_pr_reply",
  "repo_write_pr_resolve_thread",
  "repo_ci_status",
  "repo_write_ci_retry_failed",
  "repo_merge_gate_prepare",
  "repo_write_merge",
  "repo_post_merge_readback",
  "repo_task_admission"
] as const satisfies readonly ToolName[];

const HEAD_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const SHA256 = "3".repeat(64);
const OPERATION_ID = "operation-0001";
const TASK_ID = "task-0001";
const REPO_ID = "fixture";
const taskState = {
  operation_id: OPERATION_ID,
  repo_id: REPO_ID,
  task_id: TASK_ID,
  expected_head_sha: HEAD_SHA,
  expected_tree_sha: TREE_SHA
};

const validInputs = {
  repo_task_open: {
    operation_id: OPERATION_ID,
    repo_id: REPO_ID,
    task_id: TASK_ID,
    base_branch: "main",
    base_commit_sha: HEAD_SHA,
    base_tree_sha: TREE_SHA,
    authority: "ship",
    goal: "Deliver one exact lifecycle task.",
    branch_slug: "exact-lifecycle-task"
  },
  repo_task_status: { repo_id: REPO_ID, task_id: TASK_ID },
  repo_task_close: { ...taskState, outcome: "completed", summary: "Lifecycle task completed." },
  repo_task_cleanup: { ...taskState, cleanup_scope: "workspace_only" },
  repo_artifact_read: { repo_id: REPO_ID, artifact_id: "artifact_1234567890abcdef", offset: 0, length: 65_536 },
  repo_run_fable_review: {
    operation_id: OPERATION_ID,
    repo_id: REPO_ID,
    task_id: TASK_ID,
    expected_base_commit_sha: HEAD_SHA,
    expected_base_tree_sha: TREE_SHA,
    expected_head_sha: HEAD_SHA,
    expected_tree_sha: TREE_SHA,
    review_kind: "initial",
    scope: { kind: "all_changes" }
  },
  repo_remote_status: taskState,
  repo_write_push: taskState,
  repo_pr_create_or_update: { ...taskState, title: "Exact lifecycle task", body: "Bound PR body.", draft: true },
  repo_pr_status: taskState,
  repo_pr_review_threads: { ...taskState, limit: 50 },
  repo_write_pr_reply: { ...taskState, thread_id: "PRRT_1234567890", body: "Addressed in the bound HEAD." },
  repo_write_pr_resolve_thread: { ...taskState, thread_id: "PRRT_1234567890", expected_thread_updated_at: "2026-08-23T00:00:00.000Z" },
  repo_ci_status: taskState,
  repo_write_ci_retry_failed: { ...taskState, ci_status_id: "ci_status_1234567890abcdef", failed_run_ids: ["123456789"] },
  repo_merge_gate_prepare: taskState,
  repo_write_merge: {
    ...taskState,
    manifest_id: "merge_manifest_1234567890abcdef",
    manifest_sha256: SHA256,
    approval_id: "merge_approval_1234567890abcdef"
  },
  repo_post_merge_readback: { ...taskState, merge_operation_id: "operation-merge-0001" },
  repo_task_admission: {
    repo_id: REPO_ID,
    task_id: TASK_ID,
    expected: {
      base_branch: "main",
      base_commit_sha: HEAD_SHA,
      base_tree_sha: TREE_SHA,
      authority: "implement",
      goal_sha256: SHA256,
      branch_slug: "exact-lifecycle-task",
      head_sha: HEAD_SHA,
      tree_sha: TREE_SHA
    }
  }
} as const satisfies Record<(typeof LIFECYCLE_TOOL_ORDER)[number], Record<string, unknown>>;

describe("lifecycle tool contracts", () => {
  test("preserves the local prefix and appends exactly 19 canonical lifecycle names without aliases", () => {
    expect(CANONICAL_TOOL_ORDER).toHaveLength(67);
    expect(CANONICAL_TOOL_ORDER.slice(0, 48)).toEqual(INHERITED_TOOL_ORDER);
    expect(CANONICAL_TOOL_ORDER.slice(48)).toEqual(LIFECYCLE_TOOL_ORDER);
    expect(new Set(CANONICAL_TOOL_ORDER).size).toBe(67);
    expect(Object.keys(toolContracts)).toHaveLength(67);
    expect([...CANONICAL_TOOL_ORDER].sort()).toEqual(Object.keys(toolContracts).sort());
    expect(toolRegistry.map(({ name }) => name)).toEqual(CANONICAL_TOOL_ORDER);
    expect(toolsForPackage("lifecycle").map(({ name }) => name)).toEqual(LIFECYCLE_TOOL_ORDER);
  });

  test("accepts exact lifecycle inputs and rejects unknown top-level fields", () => {
    for (const name of LIFECYCLE_TOOL_ORDER) {
      const contract = toolContracts[name];
      const input = validInputs[name];
      expect(contract.input.safeParse(input).success, name).toBe(true);
      expect(contract.input.safeParse({ ...input, unexpected: true }).success, `${name} must be strict`).toBe(false);
      if (name !== "repo_merge_gate_prepare") {
        expect(contract.output.partial().safeParse({ unexpected: true }).success, `${name} output must be strict`).toBe(false);
      }
    }
  });

  test("requires operation, repository, task, HEAD, and tree bindings for task mutations and external calls", () => {
    const commonBoundTools = LIFECYCLE_TOOL_ORDER.filter((name) => ![
      "repo_task_open",
      "repo_task_status",
      "repo_task_admission",
      "repo_artifact_read"
    ].includes(name));

    for (const name of commonBoundTools) {
      for (const key of ["operation_id", "repo_id", "task_id", "expected_head_sha", "expected_tree_sha"] as const) {
        const input: Record<string, unknown> = { ...validInputs[name] };
        delete input[key];
        expect(toolContracts[name].input.safeParse(input).success, `${name} must require ${key}`).toBe(false);
      }
    }

    for (const key of ["operation_id", "repo_id", "task_id", "base_branch", "base_commit_sha", "base_tree_sha", "authority", "goal", "branch_slug"] as const) {
      const input = { ...validInputs.repo_task_open } as Record<string, unknown>;
      delete input[key];
      expect(RepoTaskOpenInputSchema.safeParse(input).success, `repo_task_open must require ${key}`).toBe(false);
    }
  });

  test("keeps artifact reads opaque, path-free, offset-based, and bounded", () => {
    expect(Object.keys(RepoArtifactReadInputSchema.shape).sort()).toEqual(["artifact_id", "length", "offset", "repo_id"]);
    expect(RepoArtifactReadInputSchema.safeParse(validInputs.repo_artifact_read).success).toBe(true);
    expect(RepoArtifactReadInputSchema.safeParse({ ...validInputs.repo_artifact_read, path: "secret.txt" }).success).toBe(false);
    expect(RepoArtifactReadInputSchema.safeParse({ ...validInputs.repo_artifact_read, artifact_id: "../artifact" }).success).toBe(false);
    expect(RepoArtifactReadInputSchema.safeParse({ ...validInputs.repo_artifact_read, length: 65_537 }).success).toBe(false);
    expect(RepoArtifactReadInputSchema.safeParse({ ...validInputs.repo_artifact_read, offset: -1 }).success).toBe(false);
  });

  test("keeps task admission strict, read-only, and typed", () => {
    expect(RepoTaskAdmissionInputSchema.safeParse(validInputs.repo_task_admission).success).toBe(true);
    expect(RepoTaskAdmissionInputSchema.safeParse({ ...validInputs.repo_task_admission, unexpected: true }).success).toBe(false);
    for (const admission of ["task_absent", "matching_active_task", "conflicting_active_task"] as const) {
      expect(TaskAdmissionStateSchema.options.some((option) => option.shape.status.value === admission)).toBe(true);
    }
  });

  test("covers exact task terminal outcomes, evidence artifacts, and Draft-only PR creation", () => {
    for (const outcome of ["completed", "blocked", "abandoned", "superseded"] as const) {
      expect(toolContracts.repo_task_close.input.safeParse({
        ...validInputs.repo_task_close,
        outcome
      }).success, outcome).toBe(true);
    }
    expect(toolContracts.repo_task_close.input.safeParse({
      ...validInputs.repo_task_close,
      outcome: "paused"
    }).success).toBe(false);

    expect(toolContracts.repo_pr_create_or_update.input.safeParse(validInputs.repo_pr_create_or_update).success).toBe(true);
    expect(toolContracts.repo_pr_create_or_update.input.safeParse({
      ...validInputs.repo_pr_create_or_update,
      draft: false
    }).success).toBe(false);

    const artifactKind = toolContracts.repo_task_open.output.shape.artifact.shape.kind;
    for (const kind of ["validation_log", "large_diff", "ci_evidence", "review_evidence", "merge_gate_evidence", "post_merge_evidence"]) {
      expect(artifactKind.safeParse(kind).success, kind).toBe(true);
    }
  });

  test("binds push and merge inputs without caller-selected remote, branch, URL, PR, or command surfaces", () => {
    expect(Object.keys(RepoWritePushInputSchema.shape).sort()).toEqual([
      "expected_head_sha",
      "expected_tree_sha",
      "operation_id",
      "repo_id",
      "task_id"
    ]);
    expect(Object.keys(RepoWriteMergeInputSchema.shape).sort()).toEqual([
      "approval_id",
      "expected_head_sha",
      "expected_tree_sha",
      "manifest_id",
      "manifest_sha256",
      "operation_id",
      "repo_id",
      "task_id"
    ]);
    for (const forbidden of ["branch", "force", "remote", "url", "owner", "pr_number", "command", "argv"]) {
      expect(forbidden in RepoWritePushInputSchema.shape).toBe(false);
      expect(forbidden in RepoWriteMergeInputSchema.shape).toBe(false);
    }
  });

  test("admits at most one transient CI retry and forbids remote branch deletion", () => {
    expect(RepoWriteCiRetryFailedInputSchema.safeParse({
      ...validInputs.repo_write_ci_retry_failed,
      failed_run_ids: ["123456789", "987654321"]
    }).success).toBe(false);
    expect(RepoMergeGatePrepareInputSchema.safeParse({
      ...validInputs.repo_merge_gate_prepare,
      remote_branch_retained: false
    }).success).toBe(false);
    expect(RepoMergeGatePrepareInputSchema.safeParse({
      ...validInputs.repo_merge_gate_prepare,
      merge_method: "squash"
    }).success).toBe(false);
    expect("merge_method" in RepoMergeGatePrepareInputSchema.shape).toBe(false);
    expect("delete_task_branch" in RepoMergeGatePrepareInputSchema.shape).toBe(false);
  });

  test("requires an exact owner-CLI manifest and keeps merge preparation read-only", () => {
    expect(Object.keys(RepoWriteMergeInputSchema.shape)).toEqual(expect.arrayContaining(["manifest_id", "manifest_sha256", "approval_id"]));
    const blockedResult = {
      ok: true,
      operation_id: OPERATION_ID,
      repo_id: REPO_ID,
      task_id: TASK_ID,
      eligible: false,
      blockers: [{ code: "CI_PENDING", message: "Required checks are pending." }],
      manifest: null,
      approval_surface: "owner_cli",
      approval_command: null,
      artifact: {
        artifact_id: "artifact_1234567890abcdef",
        kind: "merge_gate_evidence",
        media_type: "application/json",
        byte_length: 100,
        sha256: SHA256,
        created_at: "2026-08-23T00:00:00.000Z"
      },
      warnings: []
    } as const;
    expect(RepoMergeGatePrepareResultSchema.safeParse(blockedResult).success).toBe(true);
    expect(RepoMergeGatePrepareResultSchema.safeParse({ ...blockedResult, unexpected: true }).success).toBe(false);
  });

  test("publishes truthful open-world and idempotency annotations", () => {
    const expected = new Map<ToolName, object>([
      ["repo_task_open", safeMutationAnnotations],
      ["repo_task_status", readOnlyAnnotations],
      ["repo_task_close", safeMutationAnnotations],
      ["repo_task_cleanup", idempotentWriteAnnotations],
      ["repo_artifact_read", readOnlyAnnotations],
      ["repo_run_fable_review", openWorldOneShotMutationAnnotations],
      ["repo_remote_status", openWorldReadOnlyAnnotations],
      ["repo_write_push", openWorldMutationAnnotations],
      ["repo_pr_create_or_update", openWorldMutationAnnotations],
      ["repo_pr_status", openWorldReadOnlyAnnotations],
      ["repo_pr_review_threads", openWorldReadOnlyAnnotations],
      ["repo_write_pr_reply", openWorldNonDestructiveMutationAnnotations],
      ["repo_write_pr_resolve_thread", openWorldMutationAnnotations],
      ["repo_ci_status", openWorldReadOnlyAnnotations],
      ["repo_write_ci_retry_failed", openWorldNonDestructiveMutationAnnotations],
      ["repo_merge_gate_prepare", openWorldReadOnlyAnnotations],
      ["repo_write_merge", openWorldMutationAnnotations],
      ["repo_post_merge_readback", openWorldReadOnlyAnnotations],
      ["repo_task_admission", readOnlyAnnotations]
    ]);

    for (const tool of toolsForPackage("lifecycle")) {
      expect(tool.annotations, tool.name).toEqual(expected.get(tool.name));
      expect(tool.annotations.idempotentHint, tool.name).toBe(tool.name !== "repo_run_fable_review");
      expect(tool.requiredCapabilities).toEqual(["lifecycle"]);
      expect(tool.tier).toBe("specialist");
    }
  });

  test("keeps lifecycle handlers as direct RuntimeContext lifecycle dispatch", () => {
    const source = readFileSync("src/tools/handlers/lifecycle.ts", "utf8");
    for (const method of [
      "taskOpen",
      "taskStatus",
      "taskClose",
      "taskCleanup",
      "artifactRead",
      "remoteStatus",
      "writePush",
      "prCreateOrUpdate",
      "prStatus",
      "prReviewThreads",
      "writePrReply",
      "writePrResolveThread",
      "ciStatus",
      "writeCiRetryFailed",
      "mergeGatePrepare",
      "writeMerge",
      "postMergeReadback",
      "taskAdmission"
    ]) expect(source).toContain(`context.lifecycle.${method}(args)`);
    expect(source).toContain("context.fableReviews.run(args)");

    expect(source).not.toMatch(/\b(?:exec|execFile|spawn|fetch)\s*\(/u);
    expect(source).not.toMatch(/new\s+\w+(?:Service|Adapter)\s*\(/u);
  });
});
