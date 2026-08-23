import { z } from "zod";
import { OwnerCliError, type OwnerCliIo } from "./cli-types.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const GateIdSchema = z.string().regex(/^merge_manifest_[a-f0-9]{64}$/);
const ApprovalIdSchema = z.string().regex(/^merge_approval_[A-Za-z0-9_-]{16,160}$/);

export const OwnerMergeGateViewSchema = z.object({
  gate_id: GateIdSchema,
  gate_sha256: Sha256Schema,
  repository_id: z.string().min(1).max(256),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  repo_id: z.string().min(1).max(200),
  task_id: z.string().min(1).max(128),
  pull_request_number: z.number().int().positive(),
  pull_request_state: z.literal("OPEN"),
  pull_request_draft: z.literal(true),
  pull_request_mergeable: z.literal("MERGEABLE"),
  base_branch: z.string().min(1).max(255),
  base_sha: GitShaSchema,
  task_branch: z.string().min(1).max(255),
  head_sha: GitShaSchema,
  tree_sha: GitShaSchema,
  merge_method: z.enum(["merge", "squash", "rebase"]),
  required_checks: z.array(z.object({
    name: z.string().min(1).max(500),
    status: z.literal("success")
  }).strict()).max(64),
  unresolved_review_threads: z.literal(0),
  material_findings: z.literal(0),
  unknown_external_effects: z.literal(0),
  risks: z.array(z.string().min(1).max(500)).max(32),
  prepared_at: z.string().datetime(),
  expires_at: z.string().datetime()
}).strict().superRefine((value, context) => {
  if (value.gate_id !== `merge_manifest_${value.gate_sha256}`) {
    context.addIssue({ code: "custom", path: ["gate_id"], message: "gate_id is not bound to gate_sha256." });
  }
  if (Date.parse(value.expires_at) <= Date.parse(value.prepared_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "Gate expiry must be after preparation." });
  }
});

export const OwnerMergeApprovalViewSchema = z.object({
  approval_id: ApprovalIdSchema,
  gate_id: GateIdSchema,
  gate_sha256: Sha256Schema,
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  consumed: z.boolean(),
  consumed_at: z.string().datetime().optional(),
  consumed_by_operation_id: z.string().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
  if (value.gate_id !== `merge_manifest_${value.gate_sha256}`) {
    context.addIssue({ code: "custom", path: ["gate_id"], message: "gate_id is not bound to gate_sha256." });
  }
  if (value.consumed !== (value.consumed_at !== undefined)) {
    context.addIssue({ code: "custom", path: ["consumed_at"], message: "Consumed approval state is inconsistent." });
  }
  if (value.consumed !== (value.consumed_by_operation_id !== undefined)) {
    context.addIssue({ code: "custom", path: ["consumed_by_operation_id"], message: "Consumed approval operation binding is inconsistent." });
  }
  if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
    context.addIssue({ code: "custom", path: ["expires_at"], message: "Approval expiry must be after issuance." });
  }
});

export type OwnerMergeGateView = z.infer<typeof OwnerMergeGateViewSchema>;
export type OwnerMergeApprovalView = z.infer<typeof OwnerMergeApprovalViewSchema>;

/**
 * Adapter boundary for the durable GitHub lifecycle implementation.
 *
 * The CLI intentionally does not define a disk format. Implementations must
 * resolve the content-addressed gate and delegate approval creation and
 * inspection to the lifecycle-owned mode-0600 store.
 */
export interface OwnerApprovalCliStore {
  resolveGate(gateId: string): Promise<OwnerMergeGateView>;
  createApproval(input: { gateId: string; gateSha256: string }): Promise<OwnerMergeApprovalView>;
  inspectApproval(input: {
    approvalId: string;
    gateId: string;
    gateSha256: string;
  }): Promise<OwnerMergeApprovalView>;
}

export async function approveMerge(
  gateIdInput: string,
  store: OwnerApprovalCliStore,
  io: OwnerCliIo,
  now: () => Date = () => new Date()
): Promise<number> {
  const gateId = parseGateId(gateIdInput);
  const gate = OwnerMergeGateViewSchema.parse(await store.resolveGate(gateId));
  if (gate.gate_id !== gateId) {
    throw new OwnerCliError("GATE_BINDING_MISMATCH", "Resolved merge gate does not match --gate-id.");
  }
  if (Date.parse(gate.expires_at) <= now().getTime()) {
    throw new OwnerCliError("GATE_EXPIRED", "Merge gate has expired; prepare a fresh exact gate.");
  }

  renderGate(gate, io);
  const confirmation = await io.confirm?.("Type APPROVE to create the one-time owner approval: ");
  if (confirmation !== "APPROVE") {
    io.stderr("Approval was not created. Exact confirmation text is required.");
    return 1;
  }

  const approval = OwnerMergeApprovalViewSchema.parse(await store.createApproval({
    gateId: gate.gate_id,
    gateSha256: gate.gate_sha256
  }));
  if (approval.gate_id !== gate.gate_id || approval.gate_sha256 !== gate.gate_sha256) {
    throw new OwnerCliError("APPROVAL_BINDING_MISMATCH", "Created approval does not match the exact gate digest.");
  }
  if (approval.consumed) {
    throw new OwnerCliError("APPROVAL_STATE_INVALID", "A newly created approval cannot already be consumed.");
  }
  if (Date.parse(approval.expires_at) > Date.parse(gate.expires_at)) {
    throw new OwnerCliError("APPROVAL_EXPIRY_INVALID", "Approval expiry exceeds the exact gate expiry.");
  }
  if (Date.parse(approval.expires_at) <= now().getTime()) {
    throw new OwnerCliError("APPROVAL_EXPIRY_INVALID", "Created approval is not currently usable.");
  }

  io.stdout(`approval_id=${approval.approval_id}`);
  io.stdout(`gate_id=${approval.gate_id}`);
  io.stdout(`gate_sha256=${approval.gate_sha256}`);
  io.stdout(`issued_at=${approval.issued_at}`);
  io.stdout(`expires_at=${approval.expires_at}`);
  io.stdout("consumed=false");
  return 0;
}

export async function inspectApproval(
  input: { approvalId: string; gateId: string },
  store: OwnerApprovalCliStore,
  io: OwnerCliIo
): Promise<number> {
  const approvalId = ApprovalIdSchema.parse(input.approvalId);
  const gateId = parseGateId(input.gateId);
  const approval = OwnerMergeApprovalViewSchema.parse(await store.inspectApproval({
    approvalId,
    gateId,
    gateSha256: gateId.slice("merge_manifest_".length)
  }));
  if (approval.approval_id !== approvalId || approval.gate_id !== gateId) {
    throw new OwnerCliError("APPROVAL_BINDING_MISMATCH", "Inspected approval does not match the requested exact identifiers.");
  }
  io.stdout(JSON.stringify(approval, null, 2));
  return 0;
}

function renderGate(gate: OwnerMergeGateView, io: OwnerCliIo): void {
  io.stdout("Exact merge gate");
  io.stdout(`repository=${gate.repository}`);
  io.stdout(`repository_id=${gate.repository_id}`);
  io.stdout(`repo_id=${gate.repo_id}`);
  io.stdout(`task_id=${gate.task_id}`);
  io.stdout(`pull_request=${gate.pull_request_number}`);
  io.stdout(`pull_request_state=${gate.pull_request_state}`);
  io.stdout(`pull_request_draft=${String(gate.pull_request_draft)}`);
  io.stdout(`pull_request_mergeable=${gate.pull_request_mergeable}`);
  io.stdout(`base=${gate.base_branch}@${gate.base_sha}`);
  io.stdout(`task_branch=${gate.task_branch}`);
  io.stdout(`head_sha=${gate.head_sha}`);
  io.stdout(`tree_sha=${gate.tree_sha}`);
  io.stdout(`merge_method=${gate.merge_method}`);
  io.stdout(`gate_sha256=${gate.gate_sha256}`);
  io.stdout(`prepared_at=${gate.prepared_at}`);
  io.stdout(`expires_at=${gate.expires_at}`);
  io.stdout("required_checks:");
  if (gate.required_checks.length === 0) io.stdout("- none configured");
  for (const check of gate.required_checks) io.stdout(`- ${check.name}: ${check.status}`);
  io.stdout("risks:");
  if (gate.risks.length === 0) io.stdout("- exact gate drift or expiry will invalidate this approval");
  for (const risk of gate.risks) io.stdout(`- ${risk}`);
}

function parseGateId(value: string): string {
  const parsed = GateIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new OwnerCliError("INVALID_GATE_ID", "--gate-id must be an opaque merge_manifest_<sha256> identifier.");
  }
  return parsed.data;
}
