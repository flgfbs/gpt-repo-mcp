import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../task-runtime/canonical-json.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

// Only the installed adapter selects root and deterministic native locators.
// No evidence writes, migrations, broad searches, or provider execution.
export async function readNativePrivateFile(root: string, relative: string, maximum: number): Promise<Buffer> {
  const parts = relative.split("/");
  requireEvidence(parts.length > 0 && parts.every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
    && part !== "." && part !== ".."));
  const parents: Array<{ path: string; stat: Stats }> = [];
  let parent = root;
  for (const part of [undefined, ...parts.slice(0, -1)]) {
    if (part !== undefined) parent = join(parent, part);
    const stat = await lstat(parent);
    requireEvidence(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
      && (stat.mode & 0o777) === 0o700);
    parents.push({ path: parent, stat });
  }
  const path = join(parent, parts.at(-1)!);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const named = await lstat(path);
    requireEvidence(before.isFile() && named.isFile() && !named.isSymbolicLink()
      && before.uid === process.getuid?.() && before.nlink === 1
      && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= maximum
      && sameIdentity(before, named));
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const namedAfter = await lstat(path);
    requireEvidence(length === before.size && after.size === before.size
      && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
      && after.nlink === 1 && sameIdentity(before, after) && sameIdentity(after, namedAfter));
    for (const entry of parents) {
      const observed = await lstat(entry.path);
      requireEvidence(observed.isDirectory() && !observed.isSymbolicLink()
        && sameIdentity(entry.stat, observed));
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export function canonicalNativeJson(value: unknown): Buffer {
  // Python native receipts and bindings use sorted, ASCII JSON plus one LF.
  const encoded = canonicalJson(value).replace(/[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Buffer.from(encoded + "\n", "ascii");
}

export async function verifyNativeFableRetention(input: {
  installed_root: string;
  receipt: Record<string, unknown>;
  receipt_bytes: Buffer;
  response: string;
}): Promise<void> {
  const receipt = input.receipt;
  const record = asRecord(receipt.review_record);
  const target = asRecord(record.exact_target_bindings);
  const attempt = receipt.INVOCATION_ID;
  const responseSha = receipt.RESPONSE_SHA256;
  const packet = receipt.PACKET_BINDING;
  requireEvidence(receipt.RECEIPT_SCHEMA === "claude-review-router-attempt-receipt.v3"
    && record.schema === "claude-review-router-review-record.v2"
    && typeof attempt === "string" && /^[a-f0-9]{32}$/.test(attempt)
    && typeof responseSha === "string" && /^[a-f0-9]{64}$/.test(responseSha)
    && typeof packet === "string" && /^sha256:[a-f0-9]{64}$/.test(packet)
    && Object.keys(target).sort().join(",") === "commit,digest,target_scope_sha256,tree"
    && typeof target.commit === "string" && /^[a-f0-9]{40}$/.test(target.commit)
    && typeof target.tree === "string" && /^[a-f0-9]{40}$/.test(target.tree)
    && typeof target.target_scope_sha256 === "string" && /^[a-f0-9]{64}$/.test(target.target_scope_sha256)
    && target.digest === packet && receipt.SELECTED_OUTPUT_CARRIER === "TEXT_JSON"
    && receipt.RESPONSE_BINDING === "EXACT_JSON_TEXT"
    && receipt.CHILD_EXIT === 0 && receipt.CHILD_SIGNAL === "NONE"
    && receipt.FIRST_MODEL_EVENT === "YES" && receipt.ATTESTATION_STATUS === "PASS"
    && typeof record.review_decision_id === "string"
    && /^[A-Za-z0-9_.:-]{1,160}$/.test(record.review_decision_id)
    && typeof record.prior_review_decision_id === "string"
    && /^[A-Za-z0-9_.:-]{1,160}$/.test(record.prior_review_decision_id)
    && canonicalNativeJson(receipt).equals(input.receipt_bytes));
  const response = Buffer.from(input.response, "utf8");
  requireEvidence(response.length > 0 && response.length <= MAX_RESPONSE_BYTES
    && response.length === receipt.RESPONSE_UTF8_BYTES && sha256Hex(response) === responseSha);
  const prefix = "runtime/review-response-retention/v1";
  const bodyLocator = `${prefix}/responses/${responseSha.slice(0, 2)}/${responseSha}/${attempt}.response`;
  const bindingLocator = `${prefix}/bindings/${attempt.slice(0, 2)}/${attempt}.json`;
  const expectedBinding = {
    schema: "review-response-binding.v1", contract_version: "ReviewResponseRetentionV1",
    availability: "AVAILABLE", attempt_id: attempt,
    review_decision_id: record.review_decision_id,
    prior_review_decision_id: record.prior_review_decision_id,
    receipt_schema: receipt.RECEIPT_SCHEMA, receipt_sha256: sha256Hex(input.receipt_bytes),
    packet_sha256: packet.slice(7), target,
    carrier: { selected_output_carrier: "TEXT_JSON", response_binding: "EXACT_JSON_TEXT" },
    attestation: { model_class: "FABLE", reasoning: "MAX" },
    response_artifact: { schema: "review-response-artifact.v1", locator: bodyLocator,
      sha256: responseSha, utf8_bytes: response.length, encoding: "UTF-8",
      content: "EXACT_ALREADY_SANITIZED_REVIEW_RESPONSE" }
  };
  const bindingBytes = canonicalNativeJson(expectedBinding);
  for (let epoch = 0; epoch < 2; epoch += 1) {
    requireEvidence((await readNativePrivateFile(input.installed_root, bodyLocator, MAX_RESPONSE_BYTES)).equals(response));
    requireEvidence((await readNativePrivateFile(input.installed_root, bindingLocator, 256 * 1024)).equals(bindingBytes));
    requireEvidence(typeof receipt.SANITIZED_DIAGNOSTIC_PATH === "string");
    requireEvidence((await readNativePrivateFile(input.installed_root, receipt.SANITIZED_DIAGNOSTIC_PATH, 2 * MAX_RESPONSE_BYTES))
      .equals(input.receipt_bytes));
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function requireEvidence(value: unknown): asserts value {
  if (!value) throw new Error("STOP_MANAGED_NATIVE_RETENTION_INVALID");
}
