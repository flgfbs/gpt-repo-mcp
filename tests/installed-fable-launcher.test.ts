import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PreparedFableInvocation } from "../src/services/fable-launcher-port.js";
import { normalizeFableInvocation } from "../src/services/fable-review-normalizer.js";
import type { FableReviewPreparation } from "../src/services/fable-review-packet.js";
import { InstalledTypedFableLauncher } from "../src/services/installed-fable-launcher.js";
import { runProcessWithTail, type ProcessTailResult } from "../src/services/process-exec.js";
import { sha256Hex } from "../src/task-runtime/canonical-json.js";

vi.mock("../src/services/process-exec.js", () => ({
  runProcessWithTail: vi.fn()
}));

const ATTEMPT = "a".repeat(32);
const SCOPE = "c".repeat(64);
const HEAD = "1".repeat(40);
const TREE = "2".repeat(40);
const PACKET_BYTES = Buffer.from("REVIEW_PACKET_V1\n" + JSON.stringify({
  schema: "chat-pro-repository-fable-review-header.v1",
  target: { head_sha: HEAD, tree_sha: TREE, scope_sha256: SCOPE }
}) + "\nsynthetic packet");
const PACKET = sha256Hex(PACKET_BYTES);
const MINUTE = 60_000;
const roots: string[] = [];
const runProcess = vi.mocked(runProcessWithTail);

type Fixture = {
  root: string;
  receiptPath: string;
  receipt: Record<string, unknown>;
  payload: Record<string, unknown>;
  prepared: PreparedFableInvocation;
};

const preparation: FableReviewPreparation = {
  target: {
    base_commit_sha: "3".repeat(40),
    base_tree_sha: "4".repeat(40),
    head_sha: HEAD,
    tree_sha: TREE
  },
  scope: { kind: "all_changes", paths: [], sha256: SCOPE },
  lineage: {
    lineage_id: "fable_lineage_" + "d".repeat(32),
    epoch_id: "fable_epoch_" + "e".repeat(32),
    kind: "initial"
  },
  packet: { sha256: PACKET, body_sha256: PACKET, byte_length: PACKET_BYTES.length },
  packet_bytes: PACKET_BYTES,
  request: {},
  bundle_id: "f".repeat(32),
  admission_key: "initial:installed-launcher-fixture"
};

async function fixture(verdict: "PASS" | "REVISE" | "BLOCK" = "PASS"): Promise<Fixture> {
  // Invoke the production adapter with a fake child and only disposable evidence.
  // Neither preflight nor any installed executable/runtime is accessed.
  const root = await mkdtemp(join(tmpdir(), "installed-fable-contract-"));
  roots.push(root);
  const locator = "runtime/claude_lain2/diagnostics/invocations/" + ATTEMPT + "/receipt.json";
  const receiptPath = join(root, locator);
  const reviewResult = {
    schema: "claude-review-router-findings.v1",
    review_status: verdict,
    summary: "Synthetic retained review.",
    findings: verdict === "PASS" ? [] : [{
      finding_id: "FINDING-1",
      severity: "P1",
      summary: "Synthetic correction.",
      evidence: "Exact synthetic evidence.",
      impact: "Retain the finding.",
      uncertainty: "Synthetic test only.",
      proposed_test: "Verify result preservation."
    }]
  };
  const response = JSON.stringify(reviewResult);
  const responseBinding = {
    sha256: sha256Hex(response),
    utf8_bytes: Buffer.byteLength(response, "utf8")
  };
  const record = {
    schema: "claude-review-router-review-record.v1",
    attempt_id: ATTEMPT,
    provider_contact_state: "YES",
    valid_semantic_review_state: "YES",
    effect_disposition: "VALID_REVIEW_RESULT",
    requested_model_class_attestation: "FABLE",
    observed_model_class_attestation: "FABLE",
    requested_reasoning_attestation: "MAX",
    observed_reasoning_attestation: "MAX",
    focused_rereview_state: "INITIAL",
    exact_target_bindings: {
      commit: HEAD,
      tree: TREE,
      digest: "sha256:" + PACKET
    }
  };
  // These are the receipt fields consumed by the adapter. The pinned v2
  // receipt has no PROVIDER_RETRY_LIMIT: that control belongs to attestation.
  const receipt: Record<string, unknown> = {
    RECEIPT_SCHEMA: "claude-review-router-attempt-receipt.v2",
    INVOCATION_ID: ATTEMPT,
    SANITIZED_DIAGNOSTIC_PATH: locator,
    PROVIDER_CONTACT: "YES",
    EFFECT_DISPOSITION: "VALID_REVIEW_RESULT",
    OUTCOME_CLASS: "SUCCESS",
    RESULT: verdict,
    TERMINAL_TITLE_SUPPRESSION: "ACTIVE",
    AUTOMATIC_FALLBACK: "DISABLED",
    EXPLICIT_CONCURRENCY_LIMIT: 1,
    RESPONSE_SHA256: responseBinding.sha256,
    RESPONSE_UTF8_BYTES: responseBinding.utf8_bytes,
    review_record: record
  };
  const payload: Record<string, unknown> = {
    result: verdict,
    invocation_id: ATTEMPT,
    sanitized_diagnostic_path: locator,
    model_class: "FABLE",
    reasoning: "MAX",
    terminal_title_suppression: "ACTIVE",
    automatic_fallback: "DISABLED",
    refusal_fallback: "DISABLED",
    explicit_concurrency_limit: 1,
    response,
    review_result: reviewResult,
    response_binding: responseBinding,
    review_record: record,
    attestation: {
      capability_class: "FABLE",
      reasoning: "MAX",
      terminal_title_suppression: "ACTIVE",
      tools: "DISABLED",
      mcp: "DISABLED",
      session_persistence: false,
      automatic_fallback: "DISABLED",
      refusal_fallback: "DISABLED",
      provider_retry: "DISABLED",
      provider_retry_limit: 0
    }
  };
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  return {
    root, receiptPath, receipt, payload,
    prepared: {
      bundle_id: "f".repeat(32),
      request_sha256: "9".repeat(64),
      packet_sha256: PACKET,
      opaque_state: { installed_root: root, request_path: join(root, "request.json") }
    }
  };
}

function result(payload: Record<string, unknown>, durationMs = 0): ProcessTailResult {
  return {
    exit_code: 0,
    timed_out: false,
    duration_ms: durationMs,
    stdout_tail: "",
    stderr_tail: "",
    captured_output: { stdout: JSON.stringify(payload), stderr: "", truncated: false }
  };
}

beforeEach(() => runProcess.mockReset());
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("installed typed Fable launcher contract", () => {
  test.each(["PASS", "REVISE", "BLOCK"] as const)(
    "retains a %s result without inventing a receipt retry field",
    async verdict => {
      const f = await fixture(verdict);
      const before = await readFile(f.receiptPath);
      expect(f.receipt).not.toHaveProperty("PROVIDER_RETRY_LIMIT");
      expect(f.payload).not.toHaveProperty("response_retention");
      runProcess.mockResolvedValueOnce(result(f.payload));

      const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
      expect(invocation.receipt_readback).toMatchObject({
        ok: true, attempt_id: ATTEMPT, receipt_sha256: sha256Hex(before)
      });
      expect(normalizeFableInvocation(invocation, preparation, "initial")).toMatchObject({
        review_state: "review_completed",
        provider_contact: "YES",
        effect_disposition: "VALID_REVIEW_RESULT",
        outcome_code: verdict,
        review_result: f.payload.review_result
      });
      expect(await readFile(f.receiptPath)).toEqual(before);
      expect(runProcess).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    ["retry enabled", { provider_retry: "ENABLED" }],
    ["nonzero retry limit", { provider_retry_limit: 1 }],
    ["string retry limit", { provider_retry_limit: "0" }],
    ["boolean retry limit", { provider_retry_limit: false }],
    ["missing retry limit", { provider_retry_limit: undefined }],
    ["missing retry attestation", { provider_retry: undefined }]
  ])("rejects %s without losing known contact", async (_label, override) => {
    const f = await fixture();
    f.payload.attestation = { ...(f.payload.attestation as object), ...override };
    runProcess.mockResolvedValueOnce(result(f.payload));
    const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
    expect(invocation.receipt_readback).toEqual({
      ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED"
    });
    expect(normalizeFableInvocation(invocation, preparation, "initial")).toMatchObject({
      review_state: "contacted_incomplete", provider_contact: "YES"
    });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["response digest", { RESPONSE_SHA256: "0".repeat(64) }],
    ["response length", { RESPONSE_UTF8_BYTES: 1 }],
    ["attempt identity", { INVOCATION_ID: "0".repeat(32) }],
    ["contact", { PROVIDER_CONTACT: "NO" }],
    ["record binding", { review_record: {} }]
  ])("still rejects a mismatched %s", async (_label, override) => {
    const f = await fixture();
    await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, ...override }));
    runProcess.mockResolvedValueOnce(result(f.payload));
    const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
    expect(invocation.receipt_readback).toEqual({
      ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED"
    });
  });

  test.each([undefined, null, { availability: "UNAVAILABLE" }])(
    "accepts verified response bytes independently of retention metadata %j",
    async retention => {
      const f = await fixture();
      f.payload.response_retention = retention;
      runProcess.mockResolvedValueOnce(result(f.payload));
      const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
      expect(invocation.receipt_readback).toMatchObject({ ok: true });
      expect(normalizeFableInvocation(invocation, preparation, "initial"))
        .toMatchObject({ review_state: "review_completed", outcome_code: "PASS" });
    }
  );

  test.each([undefined, 123, "changed response"])(
    "rejects missing or changed response bytes %j",
    async response => {
      const f = await fixture();
      f.payload.response = response;
      runProcess.mockResolvedValueOnce(result(f.payload));
      const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
      expect(invocation.receipt_readback).toEqual({
        ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED"
      });
      expect(normalizeFableInvocation(invocation, preparation, "initial"))
        .toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    }
  );

  test("rejects an escaping receipt locator", async () => {
    const f = await fixture();
    f.payload.sanitized_diagnostic_path = "../receipt.json";
    runProcess.mockResolvedValueOnce(result(f.payload));
    expect((await new InstalledTypedFableLauncher().invoke(f.prepared)).receipt_readback)
      .toEqual({ ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED" });
  });

  test.each([21 * MINUTE, 31 * MINUTE, 60 * MINUTE + 5_000])(
    "allows a bounded queued invocation lasting %i ms to finish",
    async durationMs => {
      const f = await fixture();
      runProcess.mockImplementationOnce(async input => durationMs < input.timeout_ms
        ? result(f.payload, durationMs)
        : { ...result(f.payload, input.timeout_ms), timed_out: true });
      const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
      expect(invocation.receipt_readback).toMatchObject({ ok: true });
      expect(runProcess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        executable: join(f.root, "typed_fable_launcher.py"),
        args: ["invoke", join(f.root, "request.json"), f.prepared.request_sha256],
        timeout_ms: 65 * MINUTE
      }));
    }
  );

  test("keeps an expired outer deadline unknown and does not retry", async () => {
    const f = await fixture();
    runProcess.mockImplementationOnce(async input => ({
      ...result(f.payload, input.timeout_ms), timed_out: true, signal: "SIGTERM"
    }));
    const invocation = await new InstalledTypedFableLauncher().invoke(f.prepared);
    expect(invocation).toMatchObject({ timed_out: true, output_complete: false });
    expect(invocation).not.toHaveProperty("receipt_readback");
    expect(normalizeFableInvocation(invocation, preparation, "initial")).toMatchObject({
      review_state: "unknown_effect", provider_contact: "UNKNOWN"
    });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
