import type { OwnerMergeApproval } from "../github/owner-approval-store.js";
import { GitHubBoundaryError, type JsonValue } from "../github/types.js";
import { createLifecycleRuntimeBundle } from "../services/lifecycle-factory.js";
import { parseMergeGateManifestCore } from "../services/github-merge-gate-service.js";
import { RootRegistry } from "../services/root-registry.js";
import { OwnerCliError } from "./cli-types.js";
import {
  OwnerMergeApprovalViewSchema,
  OwnerMergeGateViewSchema,
  type OwnerApprovalCliStore,
  type OwnerMergeApprovalView,
  type OwnerMergeGateView
} from "./owner-approval.js";

type GitHubBundle = NonNullable<Awaited<ReturnType<typeof createLifecycleRuntimeBundle>>["github"]>;

export class DurableOwnerApprovalCliStore implements OwnerApprovalCliStore {
  constructor(
    private readonly github: GitHubBundle,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolveGate(gateId: string): Promise<OwnerMergeGateView> {
    return this.boundary(async () => {
      const digest = gateDigest(gateId);
      const value = await this.github.githubArtifacts.getJson({
        namespace: "github-merge-gates",
        digest
      });
      if (value === undefined) throw new OwnerCliError("GATE_NOT_FOUND", "Exact merge gate is unavailable.");
      const core = parseMergeGateManifestCore(value);
      if (core.unresolvedThreadIds.length !== 0 || core.materialFindingCount !== 0) {
        throw new OwnerCliError("GATE_INVALID", "Stored merge gate contains unresolved material blockers.");
      }
      const ciDigest = ciDigestFromStatusId(core.ciStatusId);
      const ci = await this.github.githubArtifacts.getJson({ namespace: "github-ci-evidence", digest: ciDigest });
      if (ci === undefined) throw new OwnerCliError("GATE_CI_EVIDENCE_MISSING", "Exact CI evidence for the merge gate is unavailable.");
      const requiredChecks = requiredCheckViews(ci);
      return OwnerMergeGateViewSchema.parse({
        gate_id: gateId,
        gate_sha256: digest,
        repository_id: core.repositoryId,
        repository: core.repositoryNameWithOwner,
        repo_id: core.repoId,
        task_id: core.taskId,
        pull_request_number: core.pullRequestNumber,
        pull_request_state: core.pullRequestState,
        pull_request_draft: core.pullRequestDraft,
        pull_request_mergeable: core.pullRequestMergeable,
        base_branch: core.baseBranch,
        base_sha: core.baseSha,
        task_branch: core.taskBranch,
        head_sha: core.headSha,
        tree_sha: core.treeSha,
        merge_method: core.mergeMethod,
        required_checks: requiredChecks,
        unresolved_review_threads: 0,
        material_findings: 0,
        unknown_external_effects: 0,
        risks: [
          "Approval is bound to this exact manifest and expires with the gate.",
          "Merge changes Draft to Ready immediately before the exact-head merge.",
          "The remote task branch is retained after merge."
        ],
        prepared_at: core.preparedAt,
        expires_at: core.expiresAt
      });
    });
  }

  async createApproval(input: { gateId: string; gateSha256: string }): Promise<OwnerMergeApprovalView> {
    return this.boundary(async () => {
      if (gateDigest(input.gateId) !== input.gateSha256) {
        throw new OwnerCliError("GATE_BINDING_MISMATCH", "gateId is not bound to gateSha256.");
      }
      const gate = await this.resolveGate(input.gateId);
      const remainingMs = Date.parse(gate.expires_at) - this.now().getTime() - 1_000;
      if (remainingMs < 1_000) throw new OwnerCliError("GATE_EXPIRED", "Merge gate has no safe approval lifetime remaining.");
      return approvalView(await this.github.approvals.create({
        gateId: input.gateId,
        gateSha256: input.gateSha256,
        ttlMs: Math.min(10 * 60 * 1_000, Math.floor(remainingMs))
      }));
    });
  }

  async inspectApproval(input: {
    approvalId: string;
    gateId: string;
    gateSha256: string;
  }): Promise<OwnerMergeApprovalView> {
    return this.boundary(async () => approvalView(await this.github.approvals.inspect(input)));
  }

  private async boundary<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OwnerCliError) throw error;
      if (error instanceof GitHubBoundaryError) {
        throw new OwnerCliError(error.code, "Durable owner approval state failed closed.");
      }
      throw error;
    }
  }
}

export async function createDefaultOwnerApprovalCliStore(configPath: string): Promise<OwnerApprovalCliStore> {
  const registry = await RootRegistry.fromFile(configPath);
  const bundle = await createLifecycleRuntimeBundle(registry);
  if (!bundle.github) throw new OwnerCliError("APPROVAL_STORE_UNAVAILABLE", "Production owner approval store is unavailable.");
  return new DurableOwnerApprovalCliStore(bundle.github);
}

function approvalView(value: OwnerMergeApproval): OwnerMergeApprovalView {
  return OwnerMergeApprovalViewSchema.parse({
    approval_id: value.approvalId,
    gate_id: value.gateId,
    gate_sha256: value.gateSha256,
    issued_at: value.issuedAt,
    expires_at: value.expiresAt,
    consumed: value.consumed,
    ...(value.consumedAt ? { consumed_at: value.consumedAt } : {}),
    ...(value.consumedByOperationId ? { consumed_by_operation_id: value.consumedByOperationId } : {})
  });
}

function gateDigest(gateId: string): string {
  const match = /^merge_manifest_([a-f0-9]{64})$/.exec(gateId);
  if (!match) throw new OwnerCliError("INVALID_GATE_ID", "gate_id must be a content-bound merge manifest id.");
  return match[1]!;
}

function ciDigestFromStatusId(ciStatusId: string): string {
  const match = /^ci_status_([a-f0-9]{64})$/.exec(ciStatusId);
  if (!match) throw new OwnerCliError("GATE_INVALID", "Merge gate CI status id is invalid.");
  return match[1]!;
}

function requiredCheckViews(value: JsonValue): { name: string; status: "success" }[] {
  const record = jsonRecord(value, "CI evidence");
  const checks = record.requiredChecks;
  if (!Array.isArray(checks)) throw new OwnerCliError("GATE_CI_EVIDENCE_INVALID", "CI required checks are invalid.");
  return checks.map((entry) => {
    const check = jsonRecord(entry, "required check");
    if (typeof check.key !== "string" || check.status !== "success") {
      throw new OwnerCliError("GATE_CI_EVIDENCE_INVALID", "A gate required check is not successful.");
    }
    return { name: check.key, status: "success" as const };
  });
}

function jsonRecord(value: JsonValue | undefined, field: string): { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OwnerCliError("GATE_EVIDENCE_INVALID", `${field} is not a fixed JSON object.`);
  }
  return value;
}
