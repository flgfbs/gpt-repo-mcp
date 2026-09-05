import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import {
  FableReviewResultSchema,
  type RepoRunFableReviewInput,
  type FableReviewResult
} from "../contracts/fable-review.contract.js";
import { canonicalJson, canonicalSha256, digestRecord, hashedDiskKey, sha256Hex } from "../task-runtime/canonical-json.js";
import { hasCode, type SecureRuntimeFs } from "../task-runtime/secure-runtime-fs.js";
import type { FableReviewPreparation } from "./fable-review-packet.js";
import type { NormalizedFableOutcome } from "./fable-review-normalizer.js";
import { SecretScanner } from "./secret-scanner.js";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ReceivedFableReview = {
  schema: "chat-pro-repository-fable-received.v1";
  verification_state: "UNVERIFIED_NOT_REVIEW_AUTHORITY";
  operation_id: string;
  repo_id: string;
  task_id: string;
  target: FableReviewPreparation["target"];
  scope: FableReviewPreparation["scope"];
  packet: FableReviewPreparation["packet"];
  lineage: FableReviewPreparation["lineage"];
  attempt_id: string | null;
  received_review: FableReviewResult;
  response: string | null;
  response_sha256: string | null;
  response_utf8_bytes: number;
  record_sha256: string;
};

// This store is private to the task runtime, never the installed router root.
// A received record preserves evidence; it cannot authorize a review or replay.
export class FableReceivedStore {
  private readonly scanner = new SecretScanner();
  constructor(private readonly fs: SecureRuntimeFs) {}

  async assertFresh(input: RepoRunFableReviewInput): Promise<void> {
    const path = receivedFablePath(input.task_id, input.operation_id);
    await this.checkParents(path, true);
    try {
      await this.readBytes(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    throw new Error("STOP_MANAGED_RECEIVED_RECORD_ALREADY_EXISTS");
  }

  async retain(
    input: RepoRunFableReviewInput,
    preparation: FableReviewPreparation,
    payload: unknown
  ): Promise<ReceivedFableReview | undefined> {
    const value = asRecord(payload);
    const parsed = FableReviewResultSchema.safeParse(value.review_result);
    if (!parsed.success) return undefined;
    const response = typeof value.response === "string" ? value.response : null;
    if (response !== null && (
      Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES
      || Buffer.from(response, "utf8").toString("utf8") !== response
    )) throw new Error("STOP_MANAGED_RECEIVED_RESPONSE_INVALID");
    const unsigned: Omit<ReceivedFableReview, "record_sha256"> = {
      schema: "chat-pro-repository-fable-received.v1",
      verification_state: "UNVERIFIED_NOT_REVIEW_AUTHORITY",
      operation_id: input.operation_id,
      repo_id: input.repo_id,
      task_id: input.task_id,
      target: preparation.target,
      scope: preparation.scope,
      packet: preparation.packet,
      lineage: preparation.lineage,
      attempt_id: typeof value.invocation_id === "string" && /^[a-f0-9]{32}$/.test(value.invocation_id)
        ? value.invocation_id : null,
      received_review: parsed.data,
      response,
      response_sha256: response === null ? null : sha256Hex(response),
      response_utf8_bytes: response === null ? 0 : Buffer.byteLength(response, "utf8")
    };
    const record: ReceivedFableReview = { ...unsigned, record_sha256: canonicalSha256(unsigned) };
    const rendered = canonicalJson(record);
    if (this.scanner.hasSecretValue(rendered) || rendered.includes(homedir() + "/") || rendered.includes("\\u0000")) {
      throw new Error("STOP_MANAGED_REVIEW_OUTPUT_BLOCKED");
    }
    const bytes = Buffer.from(rendered, "utf8");
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("STOP_MANAGED_RECEIVED_RESPONSE_TOO_LARGE");
    const path = receivedFablePath(input.task_id, input.operation_id);
    await this.checkParents(path, false);
    await this.fs.atomicWrite(path, bytes, { exclusive: true });
    const readBack = await this.readBytes(path);
    if (!readBack.equals(bytes)) throw new Error("STOP_MANAGED_RECEIVED_READBACK_FAILED");
    return record;
  }

  private async checkParents(relative: string, create: boolean): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("STOP_MANAGED_OWNER_ID_UNAVAILABLE");
    let current = this.fs.root;
    const directories = [current];
    for (const part of posix.dirname(relative).split("/")) {
      current = join(current, part);
      directories.push(current);
    }
    for (const directory of directories) {
      if (create && directory !== this.fs.root) {
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      }
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid
        || (metadata.mode & 0o777) !== 0o700) throw new Error("STOP_MANAGED_RECEIVED_DIRECTORY_UNSAFE");
    }
  }

  private async readBytes(relative: string): Promise<Buffer> {
    await this.checkParents(relative, false);
    const path = this.fs.absolutePath(relative);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      const named = await lstat(path);
      if (!before.isFile() || !named.isFile() || before.uid !== process.getuid?.()
        || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
        || before.size > MAX_RECORD_BYTES || before.dev !== named.dev || before.ino !== named.ino) {
        throw new Error("STOP_MANAGED_RECEIVED_FILE_UNSAFE");
      }
      const buffer = Buffer.alloc(before.size + 1);
      let total = 0;
      while (total < buffer.length) {
        const result = await handle.read(buffer, total, buffer.length - total, null);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }
      const after = await handle.stat();
      const namedAfter = await lstat(path);
      if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || after.dev !== namedAfter.dev || after.ino !== namedAfter.ino) {
        throw new Error("STOP_MANAGED_RECEIVED_READBACK_FAILED");
      }
      return buffer.subarray(0, total);
    } finally {
      await handle.close();
    }
  }

  async read(input: Pick<RepoRunFableReviewInput, "repo_id" | "task_id" | "operation_id">): Promise<ReceivedFableReview> {
    // Historical reads bind the operation, not a mutable checkout HEAD.
    const bytes = await this.readBytes(receivedFablePath(input.task_id, input.operation_id));
    const record = JSON.parse(bytes.toString("utf8")) as ReceivedFableReview;
    if (record.schema !== "chat-pro-repository-fable-received.v1"
      || record.verification_state !== "UNVERIFIED_NOT_REVIEW_AUTHORITY"
      || record.repo_id !== input.repo_id || record.task_id !== input.task_id
      || record.operation_id !== input.operation_id
      || digestRecord(record, "record_sha256") !== record.record_sha256) {
      throw new Error("STOP_MANAGED_RECEIVED_BINDING_MISMATCH");
    }
    FableReviewResultSchema.parse(record.received_review);
    return record;
  }
}

export function receivedFablePath(taskId: string, operationId: string): string {
  return posix.join("fable-received", hashedDiskKey("fable-received-task", taskId),
    `${hashedDiskKey("fable-received-operation", operationId)}.json`);
}

export function receivedReviewMatches(record: ReceivedFableReview | undefined, outcome: NormalizedFableOutcome): boolean {
  if (!record || !outcome.receipt || !outcome.review_result || record.response === null) return false;
  try {
    let text = record.response;
    const fenced = text.trim().match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/);
    if (fenced) text = fenced[1]!;
    const decoded = FableReviewResultSchema.parse(JSON.parse(text));
    return record.attempt_id === outcome.receipt.attempt_id
      && record.response_sha256 === outcome.receipt.response_sha256
      && record.response_utf8_bytes === outcome.receipt.response_utf8_bytes
      && canonicalJson(record.received_review) === canonicalJson(outcome.review_result)
      && canonicalJson(decoded) === canonicalJson(outcome.review_result);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
