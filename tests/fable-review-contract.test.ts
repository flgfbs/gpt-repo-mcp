import { describe, expect, test } from "vitest";
import {
  FableReviewEvidenceSchema,
  RepoRunFableReviewInputSchema,
  RepoRunFableReviewResultSchema
} from "../src/contracts/fable-review.contract.js";

const HEAD = "1".repeat(40);
const TREE = "2".repeat(40);
const BASE = "3".repeat(40);
const BASE_TREE = "4".repeat(40);
const SHA = "5".repeat(64);

const initial = {
  operation_id: "operation-fable-contract",
  repo_id: "task-1234567890abcdef1234567890abcdef12345678",
  task_id: "managed-fable-task",
  expected_base_commit_sha: BASE,
  expected_base_tree_sha: BASE_TREE,
  expected_head_sha: HEAD,
  expected_tree_sha: TREE,
  review_kind: "initial",
  scope: { kind: "all_changes" }
} as const;

const evidence = {
  schema: "chat-pro-repository-managed-fable-review.v1",
  operation_id: initial.operation_id,
  repo_id: initial.repo_id,
  task_id: initial.task_id,
  review_state: "failed_precontact",
  provider_contact: "NO",
  effect_disposition: "NO_EXTERNAL_EFFECT",
  model_class: "FABLE",
  reasoning: "MAX",
  target: {
    base_commit_sha: BASE,
    base_tree_sha: BASE_TREE,
    head_sha: HEAD,
    tree_sha: TREE
  },
  scope: {
    kind: "all_changes",
    paths: [],
    sha256: SHA
  },
  outcome_code: "STOP_PREFLIGHT",
  retry_authorized: false,
  fallback_authorized: false,
  reroute_authorized: false,
  continuation_authorized: false,
  recorded_at: "2026-09-04T00:00:00.000Z"
} as const;

describe("managed Fable review public contract", () => {
  test("requires exact active-task, base, HEAD, tree, operation, and scope bindings", () => {
    expect(RepoRunFableReviewInputSchema.safeParse(initial).success).toBe(true);
    for (const key of [
      "operation_id",
      "repo_id",
      "task_id",
      "expected_base_commit_sha",
      "expected_base_tree_sha",
      "expected_head_sha",
      "expected_tree_sha",
      "review_kind",
      "scope"
    ] as const) {
      const candidate: Record<string, unknown> = { ...initial };
      delete candidate[key];
      expect(RepoRunFableReviewInputSchema.safeParse(candidate).success, key).toBe(false);
    }
  });

  test("rejects commands, caller paths, broad roots, models, credentials, retries, fallback, and reroute", () => {
    for (const [field, value] of Object.entries({
      command: "run something",
      argv: ["run"],
      executable: "/tmp/program",
      path: "/tmp/request.json",
      writable_root: "/",
      writable_roots: ["/"],
      environment: { HOME: "/tmp" },
      model: "provider-model",
      model_slug: "provider-model",
      credentials: "caller-data",
      retry: true,
      fallback: true,
      reroute: true,
      route: "SECONDARY",
      packet: "caller packet",
      prompt: "caller prompt"
    })) {
      expect(RepoRunFableReviewInputSchema.safeParse({ ...initial, [field]: value }).success, field).toBe(false);
    }
  });

  test("keeps focused paths canonical, relative, sorted, unique, and outside control roots", () => {
    const focused = {
      ...initial,
      review_kind: "focused_rereview",
      prior_review_artifact_id: "artifact_1234567890abcdef",
      scope: { kind: "focused_paths", paths: ["src/a.ts", "tests/a.test.ts"] }
    } as const;
    expect(RepoRunFableReviewInputSchema.safeParse(focused).success).toBe(true);
    for (const paths of [
      ["/absolute.ts"],
      ["../escape.ts"],
      ["src/../escape.ts"],
      [".git/config"],
      [".chatgpt/state.json"],
      ["src\\windows.ts"],
      ["tests/z.ts", "src/a.ts"],
      ["src/a.ts", "src/a.ts"]
    ]) {
      expect(RepoRunFableReviewInputSchema.safeParse({
        ...focused,
        scope: { kind: "focused_paths", paths }
      }).success, paths.join(",")).toBe(false);
    }
  });

  test("requires all changes for initial and a retained prior artifact for focused rereview", () => {
    expect(RepoRunFableReviewInputSchema.safeParse({
      ...initial,
      scope: { kind: "focused_paths", paths: ["src/a.ts"] }
    }).success).toBe(false);
    expect(RepoRunFableReviewInputSchema.safeParse({
      ...initial,
      prior_review_artifact_id: "artifact_1234567890abcdef"
    }).success).toBe(false);
    expect(RepoRunFableReviewInputSchema.safeParse({
      ...initial,
      review_kind: "focused_rereview",
      scope: { kind: "focused_paths", paths: ["src/a.ts"] }
    }).success).toBe(false);
  });

  test("exposes only sanitized evidence fields and rejects raw or private additions", () => {
    expect(FableReviewEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(RepoRunFableReviewResultSchema.safeParse({
      ok: true,
      ...evidence,
      warnings: []
    }).success).toBe(true);
    for (const field of [
      "raw_response",
      "raw_stream",
      "private_prompt",
      "credential_value",
      "resolved_models",
      "diagnostic_path",
      "request_path",
      "runtime_data"
    ]) {
      expect(FableReviewEvidenceSchema.safeParse({ ...evidence, [field]: "forbidden" }).success, field).toBe(false);
    }
  });
});
