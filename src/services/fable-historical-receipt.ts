import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../task-runtime/canonical-json.js";
import type { HistoricalFableReadback, HistoricalFableReadbackInput } from "./fable-launcher-port.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_PACKET_BYTES = 32 * 1024 * 1024;

// Paths are selected by the installed adapter, never by MCP input. No writes,
// provider contact, shell commands, directory-wide receipt search or raw output.
export async function readHistoricalFableReceipt(
  input: HistoricalFableReadbackInput,
  roots: { installed_root: string; transport_root: string }
): Promise<HistoricalFableReadback> {
  const prior = input.evidence;
  check(/^[a-f0-9]{32}$/.test(input.attempt_id)
    && /^[a-f0-9]{32}$/.test(input.bundle_id)
    && /^[a-f0-9]{64}$/.test(input.expected_receipt_sha256),
  "STOP_MANAGED_RECOVERY_LOCATOR_INVALID");
  check(prior.packet !== undefined && prior.lineage?.kind === "initial",
    "STOP_MANAGED_RECOVERY_PACKET_REQUIRED");
  const candidates: Array<{ bytes: Buffer; locator: string; directory: string }> = [];
  await privateDirectory(roots.installed_root);
  for (const route of ["claude_lain1", "claude_lain2"]) {
    const parts = ["runtime", route, "diagnostics", "invocations", input.attempt_id];
    let directory = roots.installed_root;
    try {
      for (const part of parts) {
        directory = join(directory, part);
        await privateDirectory(directory);
      }
      const bytes = await privateFile(join(directory, "receipt.json"), MAX_RECEIPT_BYTES);
      candidates.push({ bytes, locator: parts.join("/") + "/receipt.json", directory });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  check(candidates.length === 1, "STOP_MANAGED_RECOVERY_RECEIPT_NOT_UNIQUE");
  const candidate = candidates[0]!;
  const receiptSha = sha256Hex(candidate.bytes);
  check(receiptSha === input.expected_receipt_sha256, "STOP_MANAGED_RECOVERY_RECEIPT_DIGEST_MISMATCH");
  const receipt = record(JSON.parse(candidate.bytes.toString("utf8")));
  const review = record(receipt.review_record);
  const target = record(review.exact_target_bindings);
  check(
    receipt.RECEIPT_SCHEMA === "claude-review-router-attempt-receipt.v2"
    && receipt.INVOCATION_ID === input.attempt_id
    && receipt.SANITIZED_DIAGNOSTIC_PATH === candidate.locator
    && receipt.RESULT === "REVISE"
    && receipt.PROVIDER_CONTACT === "YES"
    && receipt.EFFECT_DISPOSITION === "VALID_REVIEW_RESULT"
    && receipt.OUTCOME_CLASS === "SUCCESS"
    && receipt.ATTESTATION_STATUS === "PASS"
    && receipt.AUTOMATIC_FALLBACK === "DISABLED"
    && receipt.EXPLICIT_CONCURRENCY_LIMIT === 1
    && receipt.TERMINAL_TITLE_SUPPRESSION === "ACTIVE"
    && receipt.RESPONSE_BINDING === "EXACT_JSON_TEXT"
    && receipt.PACKET_BINDING === `sha256:${prior.packet!.sha256}`
    && review.schema === "claude-review-router-review-record.v1"
    && review.attempt_id === input.attempt_id
    && review.prior_attempt_id === "NONE"
    && review.prior_review_decision_id === "NONE"
    && review.focused_rereview_state === "INITIAL"
    && review.provider_contact_state === "YES"
    && review.valid_semantic_review_state === "YES"
    && review.effect_disposition === "VALID_REVIEW_RESULT"
    && review.result_class === "VALID_SEMANTIC_RESULT"
    && review.requested_model_class_attestation === "FABLE"
    && review.observed_model_class_attestation === "FABLE"
    && review.requested_reasoning_attestation === "MAX"
    && review.observed_reasoning_attestation === "MAX"
    && typeof review.review_decision_id === "string"
    && /^[A-Za-z0-9_.:-]{1,160}$/.test(review.review_decision_id)
    && canonicalJson(target) === canonicalJson({
      commit: prior.target.head_sha,
      tree: prior.target.tree_sha,
      digest: `sha256:${prior.packet!.sha256}`
    })
    && typeof receipt.RESPONSE_SHA256 === "string"
    && /^[a-f0-9]{64}$/.test(receipt.RESPONSE_SHA256)
    && typeof receipt.RESPONSE_UTF8_BYTES === "number"
    && Number.isSafeInteger(receipt.RESPONSE_UTF8_BYTES)
    && receipt.RESPONSE_UTF8_BYTES > 0
    && receipt.RESPONSE_UTF8_BYTES <= 1024 * 1024,
  "STOP_MANAGED_RECOVERY_RECEIPT_NOT_ELIGIBLE");

  // A new retention extension or an unexpected adjacent object is not proof
  // of absence. Refuse recovery instead of ignoring possibly retained content.
  const entries = await readdir(candidate.directory, { withFileTypes: true });
  check(entries.length <= 2 && entries.every(entry => entry.isFile()
    && ["receipt.json", "transport-journal.jsonl"].includes(entry.name))
    && receipt.response_retention === undefined
    && receipt.response === undefined && receipt.review_result === undefined,
  "STOP_MANAGED_RECOVERY_BODY_AVAILABILITY_UNKNOWN");
  await assertKnownRetentionAbsent(roots.installed_root, input.attempt_id, receipt.RESPONSE_SHA256 as string);

  await privateDirectory(roots.transport_root);
  const bundle = join(roots.transport_root, input.bundle_id);
  await privateDirectory(bundle);
  const packet = await privateFile(join(bundle, "packet.txt"), MAX_PACKET_BYTES);
  check(packet.length === prior.packet!.byte_length
    && sha256Hex(packet) === prior.packet!.sha256
    && prior.packet!.sha256 === prior.packet!.body_sha256,
  "STOP_MANAGED_RECOVERY_PACKET_DIGEST_MISMATCH");
  const text = packet.toString("utf8");
  check(Buffer.from(text, "utf8").equals(packet), "STOP_MANAGED_RECOVERY_PACKET_ENCODING_INVALID");
  const [marker, headerLine, payloadLine, ...extra] = text.split("\n");
  check(marker === "REVIEW_PACKET_V1" && headerLine !== undefined && payloadLine !== undefined
    && extra.length === 0, "STOP_MANAGED_RECOVERY_PACKET_INVALID");
  const header = record(JSON.parse(headerLine!));
  const payload = record(JSON.parse(payloadLine!));
  check(headerLine === canonicalJson(header) && payloadLine === canonicalJson(payload)
    && header.schema === "chat-pro-repository-fable-review-header.v1"
    && canonicalJson(header.target) === canonicalJson({
      head_sha: prior.target.head_sha, tree_sha: prior.target.tree_sha, scope_sha256: prior.scope.sha256
    })
    && payload.schema === "chat-pro-repository-fable-review-payload.v1"
    && canonicalJson(payload.task) === canonicalJson({ repo_id: prior.repo_id, task_id: prior.task_id })
    && canonicalJson(payload.target) === canonicalJson(prior.target)
    && canonicalJson(payload.scope) === canonicalJson(prior.scope)
    && canonicalJson(payload.lineage) === canonicalJson(prior.lineage)
    && payload.prior_review === "NONE",
  "STOP_MANAGED_RECOVERY_PACKET_BINDING_MISMATCH");
  // Rebind the exact receipt after packet inspection.
  check((await privateFile(join(candidate.directory, "receipt.json"), MAX_RECEIPT_BYTES)).equals(candidate.bytes),
    "STOP_MANAGED_RECOVERY_RECEIPT_CHANGED");
  return {
    attempt_id: input.attempt_id,
    review_decision_id: review.review_decision_id as string,
    receipt_sha256: receiptSha,
    response_sha256: receipt.RESPONSE_SHA256 as string,
    response_utf8_bytes: receipt.RESPONSE_UTF8_BYTES as number
  };
}

async function assertKnownRetentionAbsent(root: string, attemptId: string, responseSha256: string): Promise<void> {
  // Inspect only deterministic locators for this exact attempt. Never read,
  // remove, or reinterpret an existing binding/body/unavailability record.
  const prefix = ["runtime", "review-response-retention", "v1"];
  const locators = [
    [...prefix, "bindings", attemptId.slice(0, 2), `${attemptId}.json`],
    [...prefix, "responses", responseSha256.slice(0, 2), responseSha256, `${attemptId}.response`],
    [...prefix, "unavailable", attemptId.slice(0, 2), `${attemptId}.json`]
  ];
  for (const parts of locators) {
    let current = root;
    try {
      for (const part of parts.slice(0, -1)) {
        current = join(current, part);
        await privateDirectory(current);
      }
      await lstat(join(current, parts.at(-1)!));
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    throw new Error("STOP_MANAGED_RECOVERY_BODY_AVAILABILITY_UNKNOWN");
  }
}

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && (stat.mode & 0o777) === 0o700, "STOP_MANAGED_RECOVERY_DIRECTORY_UNSAFE");
}

async function privateFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    const named = await lstat(path);
    check(before.isFile() && named.isFile() && before.uid === process.getuid?.()
      && before.nlink === 1 && (before.mode & 0o777) === 0o600
      && before.size > 0 && before.size <= maximum
      && before.dev === named.dev && before.ino === named.ino,
    "STOP_MANAGED_RECOVERY_FILE_UNSAFE");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    const namedAfter = await lstat(path);
    check(length === before.size && after.size === before.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && namedAfter.dev === after.dev && namedAfter.ino === after.ino,
    "STOP_MANAGED_RECOVERY_FILE_CHANGED");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
