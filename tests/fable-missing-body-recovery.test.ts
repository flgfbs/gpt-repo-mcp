import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FableReviewEvidenceSchema, RepoRunFableReviewInputSchema } from "../src/contracts/fable-review.contract.js";
import { readHistoricalFableReceipt } from "../src/services/fable-historical-receipt.js";
import type { HistoricalFableReadbackInput } from "../src/services/fable-launcher-port.js";
import { FableReviewClaimStore } from "../src/services/fable-review-claim-store.js";
import { FableReceivedStore } from "../src/services/fable-received-store.js";
import { advanceFableReviewOperation, createFableReviewOperation, terminalizeFableReviewOperation } from "../src/services/fable-review-operation.js";
import { buildFableReviewPreparation, canonicalFableScope, targetFromInput } from "../src/services/fable-review-packet.js";
import { contactedFableOutcome } from "../src/services/fable-review-normalizer.js";
import { SecretScanner } from "../src/services/secret-scanner.js";
import { canonicalJson, hashedDiskKey, sha256Hex } from "../src/task-runtime/canonical-json.js";
import { FakeFableLauncher, commitTaskChange, initialInput, managedTaskFixture, type TaskFixture } from "./fixtures/fable-review-fixture.js";

const fixtures: TaskFixture[] = [];
const ATTEMPT = "e".repeat(32);
const DECISION = "TYPED-fixture-historical-decision";
const NOW = new Date("2026-09-04T00:00:00.000Z");
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map(f => rm(f.parent, { recursive: true, force: true })));
});

async function fixture() {
  const f = await managedTaskFixture();
  fixtures.push(f);
  const first = await commitTaskChange(f.taskRoot, "reviewed.ts", "export const value = 1;\n");
  const oldInput = initialInput(f, first, "operation-historical-initial");
  const target = targetFromInput(oldInput);
  const scope = canonicalFableScope(oldInput, target);
  const preparation = await buildFableReviewPreparation({
    request: oldInput, root: f.taskRoot, target, scope, scanner: new SecretScanner()
  });
  const outcome = contactedFableOutcome("STOP_MANAGED_RECEIPT_READBACK_FAILED");
  const prior = FableReviewEvidenceSchema.parse({
    schema: "chat-pro-repository-managed-fable-review.v1",
    operation_id: oldInput.operation_id, repo_id: f.taskRepoId, task_id: f.taskId,
    ...outcome, model_class: "FABLE", reasoning: "MAX", target, scope,
    packet: preparation.packet, lineage: preparation.lineage,
    retry_authorized: false, fallback_authorized: false, reroute_authorized: false,
    continuation_authorized: false, recorded_at: NOW.toISOString()
  });
  const operation = await createFableReviewOperation(f.bundle.tasks, oldInput, NOW);
  const admitted = await advanceFableReviewOperation(f.bundle.tasks, operation, "ADMITTED", "NOT_STARTED", NOW);
  const precontact = await advanceFableReviewOperation(f.bundle.tasks, admitted, "EXTERNAL_PRECONTACT", "NOT_STARTED", NOW);
  await terminalizeFableReviewOperation(f.bundle.tasks, precontact, outcome, f.taskRepoId, NOW);
  const claims = new FableReviewClaimStore(f.bundle.tasks.fs);
  await claims.writeClaim({
    task_id: f.taskId, admission_key: preparation.admission_key, operation_id: oldInput.operation_id,
    epoch_id: preparation.lineage.epoch_id, packet_sha256: preparation.packet.sha256, target,
    launcher_sha256: "a".repeat(64), router_sha256: "b".repeat(64), recorded_at: NOW.toISOString()
  });
  await claims.writeOutcome({
    task_id: f.taskId, admission_key: preparation.admission_key, operation_id: oldInput.operation_id,
    epoch_id: preparation.lineage.epoch_id, provider_contact: "YES",
    effect_disposition: outcome.effect_disposition, outcome_code: outcome.outcome_code, recorded_at: NOW.toISOString()
  });
  const artifact = await f.bundle.artifacts.put({
    task_id: f.taskId, kind: "review_evidence", media_type: "application/json",
    logical_path: "reviews/fable/historical.json", content: canonicalJson(prior)
  });
  const roots = { installed_root: join(f.parent, "installed"), transport_root: join(f.parent, "transport") };
  const directory = join(roots.installed_root, "runtime", "claude_lain2", "diagnostics", "invocations", ATTEMPT);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(roots.transport_root, preparation.bundle_id), { recursive: true, mode: 0o700 });
  const packetPath = join(roots.transport_root, preparation.bundle_id, "packet.txt");
  await writeFile(packetPath, preparation.packet_bytes, { mode: 0o600 });
  const receipt = {
    RECEIPT_SCHEMA: "claude-review-router-attempt-receipt.v2", INVOCATION_ID: ATTEMPT,
    SANITIZED_DIAGNOSTIC_PATH: `runtime/claude_lain2/diagnostics/invocations/${ATTEMPT}/receipt.json`,
    RESULT: "REVISE", PROVIDER_CONTACT: "YES", EFFECT_DISPOSITION: "VALID_REVIEW_RESULT",
    OUTCOME_CLASS: "SUCCESS", ATTESTATION_STATUS: "PASS", AUTOMATIC_FALLBACK: "DISABLED",
    EXPLICIT_CONCURRENCY_LIMIT: 1, TERMINAL_TITLE_SUPPRESSION: "ACTIVE", RESPONSE_BINDING: "EXACT_JSON_TEXT",
    PACKET_BINDING: `sha256:${prior.packet!.sha256}`, RESPONSE_SHA256: "b".repeat(64), RESPONSE_UTF8_BYTES: 18178,
    review_record: {
      schema: "claude-review-router-review-record.v1", attempt_id: ATTEMPT,
      prior_attempt_id: "NONE", prior_review_decision_id: "NONE", focused_rereview_state: "INITIAL",
      review_decision_id: DECISION, provider_contact_state: "YES", valid_semantic_review_state: "YES",
      effect_disposition: "VALID_REVIEW_RESULT", result_class: "VALID_SEMANTIC_RESULT",
      requested_model_class_attestation: "FABLE", observed_model_class_attestation: "FABLE",
      requested_reasoning_attestation: "MAX", observed_reasoning_attestation: "MAX",
      exact_target_bindings: { commit: target.head_sha, tree: target.tree_sha, digest: `sha256:${prior.packet!.sha256}` }
    }
  };
  const receiptPath = join(directory, "receipt.json");
  const receiptBytes = canonicalJson(receipt);
  await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
  const readback: HistoricalFableReadbackInput = {
    evidence: prior, attempt_id: ATTEMPT, bundle_id: preparation.bundle_id, expected_receipt_sha256: sha256Hex(receiptBytes)
  };
  const corrected = await commitTaskChange(f.taskRoot, "reviewed.ts", "export const value = 2;\n");
  const input = initialInput(f, corrected, "operation-missing-body-recovery", {
    review_kind: "missing_body_recovery", prior_review_artifact_id: artifact.artifact_id,
    missing_body_recovery: {
      prior_operation_id: oldInput.operation_id, prior_attempt_id: ATTEMPT,
      expected_receipt_sha256: readback.expected_receipt_sha256
    }
  });
  class RecoveryLauncher extends FakeFableLauncher {
    readHistorical(value: HistoricalFableReadbackInput) { return readHistoricalFableReceipt(value, roots); }
  }
  const launcher = new RecoveryLauncher(["PASS", "PASS"]);
  return { f, oldInput, prior, artifact, preparation, claims, roots, directory, receipt, receiptPath,
    receiptBytes, packetPath, readback, input, launcher, service: f.service(launcher) };
}

describe("missing-body recovery contract", { timeout: 30_000 }, () => {
  test("requires a new full-scope operation and exact historical locators, never caller-supplied verdicts", async () => {
    const x = await fixture();
    expect(RepoRunFableReviewInputSchema.safeParse(x.input).success).toBe(true);
    const invalid = [
      { missing_body_recovery: undefined }, { prior_review_artifact_id: undefined },
      { operation_id: x.oldInput.operation_id }, { scope: { kind: "focused_paths", paths: ["reviewed.ts"] } },
      { review_kind: "initial" }, { review_kind: "focused_rereview" },
      { missing_body_recovery: { ...x.input.missing_body_recovery, verdict: "REVISE" } },
      { missing_body_recovery: { ...x.input.missing_body_recovery, prior_attempt_id: "../receipt" } }
    ];
    for (const extra of invalid) expect(RepoRunFableReviewInputSchema.safeParse({ ...x.input, ...extra }).success).toBe(false);
    expect(FableReviewEvidenceSchema.safeParse(x.prior).success).toBe(true);
    expect(FableReviewEvidenceSchema.safeParse({ ...x.prior, schema: "chat-pro-repository-managed-fable-review.v2" }).success).toBe(false);
  });

  test("performs one linked full reexamination while preserving all old evidence bytes and consumed admission", async () => {
    const x = await fixture();
    const before = await x.f.bundle.tasks.states.readOperation(x.f.taskId, x.oldInput.operation_id);
    const initialClaim = await x.claims.readRecoveryPredecessor({
      task_id: x.f.taskId, operation_id: x.oldInput.operation_id, lineage_id: x.prior.lineage!.lineage_id,
      epoch_id: x.prior.lineage!.epoch_id, packet_sha256: x.prior.packet!.sha256, target: x.prior.target
    });
    const result = await x.service.run(x.input);
    expect(result).toMatchObject({
      schema: "chat-pro-repository-managed-fable-review.v2", review_state: "review_completed",
      provider_contact: "YES", review_result: { review_status: "PASS" },
      lineage: { kind: "missing_body_recovery", lineage_id: x.prior.lineage!.lineage_id },
      recovery: { historical_receipt_verdict: "REVISE", historical_operation_effect: "PARTIAL",
        historical_findings_reconstructed: false, historical_result_adopted: false,
        reexamination_scope: "ALL_TASK_CHANGES", prior_attempt_id: ATTEMPT }
    });
    expect(result.lineage!.epoch_id).not.toBe(x.prior.lineage!.epoch_id);
    expect(result.recovery!.prior_claim_sha256).toBe(initialClaim.claim_sha256);
    expect(result.recovery!.prior_outcome_sha256).toBe(initialClaim.outcome_sha256);
    expect(await x.f.bundle.tasks.states.readOperation(x.f.taskId, x.oldInput.operation_id)).toEqual(before);
    expect(await readFile(x.receiptPath, "utf8")).toBe(x.receiptBytes);
    const artifact = await x.f.bundle.artifacts.read({ task_id: x.f.taskId, artifact_id: x.artifact.artifact_id, offset: 0, length: 65536 });
    expect(Buffer.from(artifact.content_base64, "base64").toString()).toBe(canonicalJson(x.prior));
    const durable = `fable-recoveries/${hashedDiskKey("fable-recovery-task", x.f.taskId)}/${hashedDiskKey("fable-recovery-operation", x.input.operation_id)}.json`;
    expect(JSON.parse((await x.f.bundle.tasks.fs.readFile(durable, 65536)).toString()).recovery).toEqual(result.recovery);
    expect(x.launcher.requests[0]?.operation).toMatchObject({
      kind: "FOCUSED_REREVIEW", prior_attempt_id: ATTEMPT,
      causal_repair: { code: "MISSING_BODY_FULL_SCOPE_REEXAMINATION" }
    });
    await expect(x.claims.assertAdmissible(x.f.taskId, x.preparation.admission_key)).rejects.toThrow("REPLAY_BLOCKED");
    // A different public artifact id must not grant a second contact for the same historical operation.
    const alias = await x.f.bundle.artifacts.put({ task_id: x.f.taskId, kind: "review_evidence",
      media_type: "application/json", logical_path: "reviews/fable/alias.json", content: canonicalJson(x.prior) });
    const replay = await x.service.run({ ...x.input, operation_id: "operation-recovery-alias", prior_review_artifact_id: alias.artifact_id });
    expect(replay).toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED" });
    expect(x.launcher.invocationCount).toBe(1);
  });

  test("requires the old body to be absent, not merely unadopted", async () => {
    const x = await fixture();
    const fake = new FakeFableLauncher(["REVISE"]);
    const prepared = await fake.prepare({ bundle_id: x.preparation.bundle_id, request: x.preparation.request, packet: x.preparation.packet_bytes });
    const invocation = await fake.invoke(prepared);
    const received = new FableReceivedStore(x.f.bundle.tasks.fs);
    await received.assertFresh(x.oldInput);
    await received.retain(x.oldInput, x.preparation, invocation.payload);
    expect(await x.service.run(x.input)).toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_RECOVERY_BODY_ALREADY_RETAINED" });
    expect(x.launcher.invocationCount).toBe(0);
  });

  test("rejects a mismatched receipt, changed operation, ineligible artifact, and unchanged target before contact", async () => {
    const x = await fixture();
    const requests = [
      { ...x.input, operation_id: "operation-bad-digest", missing_body_recovery: { ...x.input.missing_body_recovery!, expected_receipt_sha256: "a".repeat(64) } },
      { ...x.input, operation_id: "operation-bad-prior", missing_body_recovery: { ...x.input.missing_body_recovery!, prior_operation_id: "operation-nonexistent" } },
      { ...x.input, operation_id: "operation-unchanged", expected_head_sha: x.prior.target.head_sha, expected_tree_sha: x.prior.target.tree_sha }
    ];
    for (const input of requests) expect((await x.service.run(input)).provider_contact).toBe("NO");
    const bad = await x.f.bundle.artifacts.put({ task_id: x.f.taskId, kind: "review_evidence", media_type: "application/json",
      logical_path: "reviews/fable/wrong-epoch.json",
      content: canonicalJson({ ...x.prior, lineage: { ...x.prior.lineage, epoch_id: "fable_epoch_" + "f".repeat(32) } }) });
    expect(await x.service.run({ ...x.input, operation_id: "operation-bad-epoch", prior_review_artifact_id: bad.artifact_id }))
      .toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_RECOVERY_OPERATION_BINDING_MISMATCH" });
    expect(x.launcher.invocationCount).toBe(0);
  });

  test("keeps additional contacted or unresolved initial claims blocking", async () => {
    const x = await fixture();
    await x.claims.writeClaim({
      task_id: x.f.taskId, admission_key: x.preparation.admission_key, operation_id: "operation-other-initial",
      epoch_id: "fable_epoch_" + "f".repeat(32), packet_sha256: x.preparation.packet.sha256,
      target: x.prior.target, launcher_sha256: "a".repeat(64), router_sha256: "b".repeat(64), recorded_at: NOW.toISOString()
    });
    expect((await x.service.run(x.input)).provider_contact).toBe("NO");
    await x.claims.writeOutcome({
      task_id: x.f.taskId, admission_key: x.preparation.admission_key, operation_id: "operation-other-initial",
      epoch_id: "fable_epoch_" + "f".repeat(32), provider_contact: "YES",
      effect_disposition: "ATTEMPT_EFFECT_ONLY", outcome_code: "STOP_OTHER_CONTACT", recorded_at: NOW.toISOString()
    });
    expect(await x.service.run({ ...x.input, operation_id: "operation-recovery-other-contact" }))
      .toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_RECOVERY_HISTORY_NOT_CLOSED" });
    expect(x.launcher.invocationCount).toBe(0);
  });

  test("permits a proven no-contact sibling without erasing it", async () => {
    const x = await fixture();
    const common = { task_id: x.f.taskId, admission_key: x.preparation.admission_key,
      operation_id: "operation-other-no-contact", epoch_id: "fable_epoch_" + "f".repeat(32), recorded_at: NOW.toISOString() };
    await x.claims.writeClaim({ ...common, packet_sha256: x.preparation.packet.sha256,
      target: x.prior.target, launcher_sha256: "a".repeat(64), router_sha256: "b".repeat(64) });
    await x.claims.writeOutcome({ ...common, provider_contact: "NO", effect_disposition: "NO_EXTERNAL_EFFECT", outcome_code: "STOP_PREFLIGHT" });
    expect(await x.service.run(x.input)).toMatchObject({ review_state: "review_completed", provider_contact: "YES" });
    expect(x.launcher.invocationCount).toBe(1);
  });

  test("rejects history drift after transport preparation without entering contact", async () => {
    const x = await fixture();
    const prepare = x.launcher.prepare.bind(x.launcher);
    vi.spyOn(x.launcher, "prepare").mockImplementation(async input => {
      const result = await prepare(input);
      await writeFile(x.receiptPath, x.receiptBytes + "\n");
      return result;
    });
    expect(await x.service.run(x.input)).toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_RECOVERY_RECEIPT_DIGEST_MISMATCH" });
    expect(x.launcher.invocationCount).toBe(0);
  });

  test("a wrong returned predecessor retains the response and consumes the recovery claim", async () => {
    const x = await fixture();
    const invoke = x.launcher.invoke.bind(x.launcher);
    vi.spyOn(x.launcher, "invoke").mockImplementation(async prepared => {
      const result = await invoke(prepared);
      const payload = result.payload as { review_record: Record<string, unknown> };
      payload.review_record.prior_attempt_id = "f".repeat(32);
      return result;
    });
    const result = await x.service.run(x.input);
    expect(result).toMatchObject({ provider_contact: "YES", review_state: "contacted_incomplete",
      outcome_code: "STOP_MANAGED_REVIEW_ATTESTATION_MISMATCH", recovery: { historical_receipt_verdict: "REVISE" } });
    expect(await new FableReceivedStore(x.f.bundle.tasks.fs).read(x.input)).toBeDefined();
    expect(await x.service.run({ ...x.input, operation_id: "operation-no-replay-after-mismatch" }))
      .toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED" });
    expect(x.launcher.invocationCount).toBe(1);
  });
});

describe("fixed-root historical receipt readback", { timeout: 30_000 }, () => {
  test("reads only the exact eligible REVISE receipt and packet without assuming missing receipt fields", async () => {
    const x = await fixture();
    const result = await readHistoricalFableReceipt(x.readback, x.roots);
    expect(result).toEqual({ attempt_id: ATTEMPT, review_decision_id: DECISION,
      receipt_sha256: sha256Hex(x.receiptBytes), response_sha256: "b".repeat(64), response_utf8_bytes: 18178 });
    expect(Object.keys(result)).not.toContain("receipt_path");
  });

  test.each(["PASS", "BLOCK", "STOP_PROVIDER_FAILURE"])("rejects historical verdict %s", async verdict => {
    const x = await fixture();
    const bytes = canonicalJson({ ...x.receipt, RESULT: verdict });
    await writeFile(x.receiptPath, bytes);
    await expect(readHistoricalFableReceipt({ ...x.readback, expected_receipt_sha256: sha256Hex(bytes) }, x.roots))
      .rejects.toThrow("STOP_MANAGED_RECOVERY_RECEIPT_NOT_ELIGIBLE");
  });

  test("rejects receipt identity, FABLE/MAX, lineage, target and retention drift even with a matching caller hash", async () => {
    const x = await fixture();
    const changes: Array<Record<string, unknown>> = [
      { PROVIDER_CONTACT: "NO" }, { INVOCATION_ID: "f".repeat(32) }, { RESPONSE_BINDING: "OTHER" },
      { response_retention: { availability: "AVAILABLE" } },
      { review_record: { ...x.receipt.review_record, prior_attempt_id: "f".repeat(32) } },
      { review_record: { ...x.receipt.review_record, observed_reasoning_attestation: "HIGH" } },
      { review_record: { ...x.receipt.review_record, exact_target_bindings: { ...x.receipt.review_record.exact_target_bindings, tree: "f".repeat(40) } } }
    ];
    for (const change of changes) {
      const bytes = canonicalJson({ ...x.receipt, ...change });
      await writeFile(x.receiptPath, bytes);
      await expect(readHistoricalFableReceipt({ ...x.readback, expected_receipt_sha256: sha256Hex(bytes) }, x.roots)).rejects.toThrow();
    }
  });

  test.each(["binding", "response", "unavailable"] as const)(
    "does not declare the old body missing when an exact separate %s record exists",
    async kind => {
      const x = await fixture();
      const root = join(x.roots.installed_root, "runtime", "review-response-retention", "v1");
      const parent = kind === "response"
        ? join(root, "responses", "bb", "b".repeat(64))
        : join(root, kind === "binding" ? "bindings" : "unavailable", ATTEMPT.slice(0, 2));
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const file = join(parent, ATTEMPT + (kind === "response" ? ".response" : ".json"));
      await writeFile(file, "unverified existing evidence", { mode: 0o600 });
      expect(await x.service.run(x.input)).toMatchObject({ provider_contact: "NO",
        outcome_code: "STOP_MANAGED_RECOVERY_BODY_AVAILABILITY_UNKNOWN" });
      expect(await readFile(file, "utf8")).toBe("unverified existing evidence");
      expect(await readFile(x.receiptPath, "utf8")).toBe(x.receiptBytes);
      expect(x.launcher.invocationCount).toBe(0);
    }
  );

  test("rejects unsafe files, links, unexpected adjacent body, duplicate receipts and packet drift", async () => {
    const x = await fixture();
    await chmod(x.receiptPath, 0o644);
    await expect(readHistoricalFableReceipt(x.readback, x.roots)).rejects.toThrow("FILE_UNSAFE");
    await chmod(x.receiptPath, 0o600);
    const body = join(x.directory, "response.json");
    await writeFile(body, "{}", { mode: 0o600 });
    await expect(readHistoricalFableReceipt(x.readback, x.roots)).rejects.toThrow("BODY_AVAILABILITY_UNKNOWN");
    await rm(body);
    await writeFile(x.packetPath, "changed packet");
    await expect(readHistoricalFableReceipt(x.readback, x.roots)).rejects.toThrow("PACKET_DIGEST_MISMATCH");
    await writeFile(x.packetPath, x.preparation.packet_bytes);
    const duplicate = join(x.roots.installed_root, "runtime", "claude_lain1", "diagnostics", "invocations", ATTEMPT);
    await mkdir(duplicate, { recursive: true, mode: 0o700 });
    await writeFile(join(duplicate, "receipt.json"), x.receiptBytes, { mode: 0o600 });
    await expect(readHistoricalFableReceipt(x.readback, x.roots)).rejects.toThrow("RECEIPT_NOT_UNIQUE");
    await rm(join(duplicate, "receipt.json"));
    await rm(x.receiptPath);
    await symlink(x.packetPath, x.receiptPath);
    await expect(readHistoricalFableReceipt(x.readback, x.roots)).rejects.toThrow();
  });
});
