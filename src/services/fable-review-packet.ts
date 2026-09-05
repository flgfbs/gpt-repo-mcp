import {
  type FableReviewEvidence,
  type FableRecoveryEvidence,
  type RepoRunFableReviewInput
} from "../contracts/fable-review.contract.js";
import { delegationControlArtifactGitExcludes } from "../policies/delegation-control-artifacts.js";
import { canonicalJson, canonicalSha256, sha256Hex } from "../task-runtime/canonical-json.js";
import type { ExactTaskMutationState } from "../task-runtime/task-service.js";
import type { FableLauncherPreflight } from "./fable-launcher-port.js";
import { runGitBounded } from "./git-exec.js";
import { GitService } from "./git-service.js";
import type { SecretScanner } from "./secret-scanner.js";

const REQUEST_SCHEMA = "claude-review-router-typed-launch.v2";
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

export type CanonicalFableScope = FableReviewEvidence["scope"];
export type ExactFableTarget = FableReviewEvidence["target"];
export type PriorFableReview = {
  artifact_id: string;
  evidence: FableReviewEvidence;
  receipt: NonNullable<FableReviewEvidence["receipt"]>;
};

export type FableReviewPreparation = {
  scope: CanonicalFableScope;
  target: ExactFableTarget;
  lineage: NonNullable<FableReviewEvidence["lineage"]>;
  packet: NonNullable<FableReviewEvidence["packet"]>;
  packet_bytes: Buffer;
  recovery?: FableRecoveryEvidence;
  request: Record<string, unknown>;
  bundle_id: string;
  admission_key: string;
};

export function targetFromInput(input: RepoRunFableReviewInput): ExactFableTarget {
  return {
    base_commit_sha: input.expected_base_commit_sha,
    base_tree_sha: input.expected_base_tree_sha,
    head_sha: input.expected_head_sha,
    tree_sha: input.expected_tree_sha
  };
}

export function canonicalFableScope(
  input: RepoRunFableReviewInput,
  target: ExactFableTarget
): CanonicalFableScope {
  const paths = input.scope.kind === "focused_paths" ? input.scope.paths : [];
  return {
    kind: input.scope.kind,
    paths,
    sha256: canonicalSha256({
      schema: "chat-pro-repository-fable-scope.v1",
      target,
      kind: input.scope.kind,
      paths
    })
  };
}

export function assertExactFableTaskBinding(
  input: RepoRunFableReviewInput,
  before: ExactTaskMutationState
): void {
  const task = before.task;
  if (
    task.repo_id !== input.repo_id
    || task.task_id !== input.task_id
    || (task.authority !== "implement" && task.authority !== "ship")
    || task.base_commit !== input.expected_base_commit_sha
    || task.base_tree !== input.expected_base_tree_sha
    || before.head !== input.expected_head_sha
    || before.tree !== input.expected_tree_sha
  ) {
    throw new Error("TASK_STATE_MISMATCH");
  }
}

export function validateFablePreflight(value: FableLauncherPreflight): void {
  if (
    value.request_schema !== REQUEST_SCHEMA
    || value.provider_contact_limit !== 1
    || value.model_class !== "FABLE"
    || value.reasoning !== "MAX"
    || !/^[a-f0-9]{64}$/.test(value.launcher_sha256)
    || !/^[a-f0-9]{64}$/.test(value.router_sha256)
  ) {
    throw new Error("STOP_MANAGED_LAUNCHER_ATTESTATION_MISMATCH");
  }
}

export async function buildFableReviewPreparation(input: {
  request: RepoRunFableReviewInput;
  root: string;
  target: ExactFableTarget;
  scope: CanonicalFableScope;
  prior?: PriorFableReview;
  recovery?: FableRecoveryEvidence;
  scanner: SecretScanner;
}): Promise<FableReviewPreparation> {
  const patch = await exactDiff(input.root, input.target.base_commit_sha, input.target.head_sha, input.scope);
  if (patch.length === 0) throw new Error("STOP_MANAGED_EMPTY_REVIEW_DIFF");
  if (input.recovery) {
    await runGitBounded({
      root: input.root,
      args: ["merge-base", "--is-ancestor", input.recovery.prior_target.head_sha, input.target.head_sha],
      max_stdout_bytes: 1024
    }).catch(() => { throw new Error("STOP_MANAGED_RECOVERY_TARGET_NOT_DESCENDANT"); });
  }
  if (input.prior) {
    const correctionPatch = await exactDiff(
      input.root,
      input.prior.evidence.target.head_sha,
      input.target.head_sha,
      input.scope
    );
    if (correctionPatch.length === 0) {
      throw new Error("STOP_MANAGED_FOCUSED_SCOPE_UNCHANGED");
    }
  }
  if (input.scanner.hasSecretValue(patch)) throw new Error("STOP_MANAGED_REVIEW_DATA_BLOCKED");
  const lineageId = input.prior?.evidence.lineage?.lineage_id
    ?? initialLineageId(input.request, input.target);
  const epochId = `fable_epoch_${canonicalSha256({
    schema: "chat-pro-repository-fable-epoch.v1",
    lineage_id: lineageId,
    operation_id: input.request.operation_id,
    target: input.target,
    scope_sha256: input.scope.sha256,
    prior_review_artifact_id: input.prior?.artifact_id ?? input.recovery?.prior_review_artifact_id ?? "NONE"
  }).slice(0, 32)}`;
  const lineage = {
    lineage_id: lineageId,
    epoch_id: epochId,
    kind: input.request.review_kind,
    ...(input.prior ? { prior_review_artifact_id: input.prior.artifact_id }
      : input.recovery ? { prior_review_artifact_id: input.recovery.prior_review_artifact_id } : {})
  } as const;
  const payload = {
    schema: "chat-pro-repository-fable-review-payload.v1",
    task: {
      repo_id: input.request.repo_id,
      task_id: input.request.task_id
    },
    target: input.target,
    scope: input.scope,
    lineage,
    ...(input.recovery ? { missing_body_recovery: input.recovery } : {}),
    prior_review: input.prior ? {
      review_status: input.prior.evidence.review_result!.review_status,
      summary: input.prior.evidence.review_result!.summary,
      findings: input.prior.evidence.review_result!.findings
    } : input.recovery ? "HISTORICAL_REVISE_BODY_UNAVAILABLE_NOT_RECONSTRUCTED" : "NONE",
    review_instructions: {
      role: "fresh independent reviewer",
      language: "Japanese",
      review_only: true,
      modify_target: false,
      exact_head_required: true,
      assess_correctness_safety_contracts_tests: true,
      ...(input.recovery ? {
        full_scope_reexamination_required: true,
        historical_findings_unavailable: true,
        not_historical_finding_closure: true
      } : {})
    },
    output_contract: {
      schema: "claude-review-router-findings.v1",
      exact_top_level_fields: ["schema", "review_status", "summary", "findings"],
      review_statuses: ["PASS", "REVISE", "BLOCK"],
      exact_finding_fields: [
        "finding_id",
        "severity",
        "summary",
        "evidence",
        "impact",
        "uncertainty",
        "proposed_test"
      ],
      severities: ["P0", "P1", "P2", "P3"]
    },
    patch
  };
  const packetHeader = {
    schema: "chat-pro-repository-fable-review-header.v1",
    target: {
      head_sha: input.target.head_sha,
      tree_sha: input.target.tree_sha,
      scope_sha256: input.scope.sha256
    }
  };
  const packetBytes = Buffer.from(
    `REVIEW_PACKET_V1\n${canonicalJson(packetHeader)}\n${canonicalJson(payload)}`,
    "utf8"
  );
  if (packetBytes.length > 32 * 1024 * 1024) throw new Error("STOP_MANAGED_PACKET_TOO_LARGE");
  const packetSha256 = sha256Hex(packetBytes);
  const packet = {
    sha256: packetSha256,
    body_sha256: packetSha256,
    byte_length: packetBytes.length
  };
  const bundleId = canonicalSha256({
    schema: "chat-pro-repository-fable-bundle.v1",
    task_id: input.request.task_id,
    operation_id: input.request.operation_id,
    epoch_id: epochId,
    packet_sha256: packetSha256
  }).slice(0, 32);
  const request = {
    schema: REQUEST_SCHEMA,
    bundle_id: bundleId,
    packet: {
      byte_length: packetBytes.length,
      sha256: packetSha256
    },
    target: {
      commit: input.target.head_sha,
      tree: input.target.tree_sha,
      digest: `sha256:${packetSha256}`
    },
    operation: {
      kind: input.prior || input.recovery ? "FOCUSED_REREVIEW" : "INITIAL",
      route: "PRIMARY",
      prior_attempt_id: input.prior?.receipt.attempt_id ?? input.recovery?.prior_attempt_id ?? "NONE",
      causal_repair: input.prior ? {
        basis: "CAUSAL_REPAIR",
        code: "FOCUSED_REVIEW_CORRECTION",
        evidence_digest: `sha256:${input.prior.receipt.receipt_sha256}`
      } : input.recovery ? {
        basis: "CAUSAL_REPAIR",
        code: "MISSING_BODY_FULL_SCOPE_REEXAMINATION",
        evidence_digest: `sha256:${canonicalSha256(input.recovery)}`
      } : {
        basis: "NONE",
        code: "NONE",
        evidence_digest: "NONE"
      },
      quota_window: {
        basis: "NONE",
        primary_attempt_id: "NONE",
        reset_at: "NONE"
      }
    },
    data: {
      classification: "TASK_AUTHORIZED_REVIEW_PACKET",
      credentials: "ABSENT",
      protected_data: "ABSENT"
    },
    output_carrier: "TEXT_JSON"
  };
  return {
    scope: input.scope,
    target: input.target,
    lineage,
    packet,
    packet_bytes: packetBytes,
    ...(input.recovery ? { recovery: input.recovery } : {}),
    request,
    bundle_id: bundleId,
    admission_key: input.prior
      ? `focused:${input.prior.artifact_id}`
      : input.recovery ? `recovery:${input.recovery.prior_operation_id}` : `initial:${lineageId}`
  };
}

export async function exactFableGitState(
  root: string,
  head: string,
  tree: string
): Promise<boolean> {
  try {
    const status = await new GitService(root).status();
    if (!status.clean || status.head_sha !== head) return false;
    const observedTree = await runGitBounded({
      root,
      args: ["rev-parse", "HEAD^{tree}"],
      max_stdout_bytes: 1024
    });
    return observedTree.stdout.trim() === tree;
  } catch {
    return false;
  }
}

async function exactDiff(
  root: string,
  baseCommit: string,
  head: string,
  scope: CanonicalFableScope
): Promise<string> {
  const pathspecs = scope.kind === "focused_paths"
    ? scope.paths.map((path) => `:(literal)${path}`)
    : [".", ...delegationControlArtifactGitExcludes()];
  const result = await runGitBounded({
    root,
    args: [
      "diff",
      "--find-renames",
      "--binary",
      "--no-ext-diff",
      "--full-index",
      baseCommit,
      head,
      "--",
      ...pathspecs
    ],
    max_stdout_bytes: MAX_DIFF_BYTES
  });
  return result.stdout;
}

function initialLineageId(input: RepoRunFableReviewInput, target: ExactFableTarget): string {
  return `fable_lineage_${canonicalSha256({
    schema: "chat-pro-repository-fable-lineage.v1",
    repo_id: input.repo_id,
    task_id: input.task_id,
    base_commit_sha: target.base_commit_sha,
    base_tree_sha: target.base_tree_sha
  }).slice(0, 32)}`;
}
