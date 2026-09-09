import { posix } from "node:path";
import type { FableReviewEvidence } from "../contracts/fable-review.contract.js";
import {
  canonicalJson,
  canonicalSha256,
  digestRecord,
  hashedDiskKey,
  sha256Hex
} from "../task-runtime/canonical-json.js";
import type { SecureRuntimeFs } from "../task-runtime/secure-runtime-fs.js";
import { hasCode } from "../task-runtime/secure-runtime-fs.js";

export class FableReviewClaimStore {
  constructor(private readonly fs: SecureRuntimeFs) {}

  async assertAdmissible(taskId: string, admissionKey: string): Promise<void> {
    const paths = claimPaths(taskId, admissionKey, "placeholder");
    await Promise.all([
      this.fs.ensureDirectory(paths.claim_directory),
      this.fs.ensureDirectory(paths.outcome_directory)
    ]);
    const claims = await this.fs.listDirectory(paths.claim_directory, 1_000);
    const admissionHash = sha256Hex(admissionKey);
    for (const entry of claims) {
      if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error("STOP_MANAGED_CLAIM_STORE_INVALID");
      }
      const claimBytes = await this.fs.readFile(
        posix.join(paths.claim_directory, entry.name),
        64 * 1024
      );
      const claim = parseDigestedRecord(claimBytes, "record_sha256");
      const operationId = claim.operation_id;
      const epochId = claim.epoch_id;
      if (
        claim.schema !== "chat-pro-repository-fable-claim.v1"
        || claim.task_id !== taskId
        || claim.admission_key_sha256 !== admissionHash
        || typeof operationId !== "string"
        || typeof epochId !== "string"
        || !/^fable_epoch_[a-f0-9]{32}$/.test(epochId)
        || `${hashedDiskKey("fable-review-operation", operationId)}.json` !== entry.name
      ) {
        throw new Error("STOP_MANAGED_CLAIM_STORE_INVALID");
      }
      const outcomePath = posix.join(paths.outcome_directory, entry.name);
      let outcomeBytes: Buffer;
      try {
        outcomeBytes = await this.fs.readFile(outcomePath, 64 * 1024);
      } catch (error) {
        if (hasCode(error, "ENOENT")) throw new Error("STOP_MANAGED_PRIOR_CLAIM_UNRESOLVED");
        throw error;
      }
      const outcome = parseDigestedRecord(outcomeBytes, "record_sha256");
      if (
        outcome.schema !== "chat-pro-repository-fable-outcome.v1"
        || outcome.task_id !== taskId
        || outcome.admission_key_sha256 !== admissionHash
        || outcome.operation_id !== operationId
        || outcome.epoch_id !== epochId
        || outcome.provider_contact !== "NO"
        || outcome.effect_disposition !== "NO_EXTERNAL_EFFECT"
      ) {
        throw new Error("STOP_MANAGED_REVIEW_REPLAY_BLOCKED");
      }
    }
  }

  async readRecoveryPredecessor(input: {
    task_id: string; operation_id: string; lineage_id: string; epoch_id: string;
    packet_sha256: string; target: FableReviewEvidence["target"];
  }): Promise<{ claim_sha256: string; outcome_sha256: string }> {
    const key = `initial:${input.lineage_id}`;
    const paths = claimPaths(input.task_id, key, input.operation_id);
    const claimBytes = await this.fs.readFile(paths.claim_path, 64 * 1024);
    const outcomeBytes = await this.fs.readFile(paths.outcome_path, 64 * 1024);
    const claim = parseDigestedRecord(claimBytes, "record_sha256");
    const outcome = parseDigestedRecord(outcomeBytes, "record_sha256");
    const common = (value: Record<string, unknown>) =>
      value.task_id === input.task_id && value.operation_id === input.operation_id
      && value.epoch_id === input.epoch_id && value.admission_key_sha256 === sha256Hex(key);
    if (!common(claim) || !common(outcome)
      || claim.schema !== "chat-pro-repository-fable-claim.v1"
      || outcome.schema !== "chat-pro-repository-fable-outcome.v1"
      || claim.packet_sha256 !== input.packet_sha256
      || canonicalJson(claim.target) !== canonicalJson(input.target)
      || outcome.provider_contact !== "YES"
      || outcome.effect_disposition !== "ATTEMPT_EFFECT_ONLY"
      || outcome.outcome_code !== "STOP_MANAGED_RECEIPT_READBACK_FAILED") {
      throw new Error("STOP_MANAGED_RECOVERY_CLAIM_BINDING_MISMATCH");
    }
    // Every other initial claim must be a proven no-contact attempt. Never
    // narrow history or admit recovery around an unresolved/additional contact.
    for (const entry of await this.fs.listDirectory(paths.claim_directory, 1000)) {
      if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        throw new Error("STOP_MANAGED_RECOVERY_HISTORY_INVALID");
      }
      if (entry.name === paths.claim_path.split("/").at(-1)) continue;
      const sibling = parseDigestedRecord(await this.fs.readFile(posix.join(paths.claim_directory, entry.name), 64 * 1024), "record_sha256");
      const settled = parseDigestedRecord(await this.fs.readFile(posix.join(paths.outcome_directory, entry.name), 64 * 1024), "record_sha256");
      if (sibling.schema !== "chat-pro-repository-fable-claim.v1"
        || settled.schema !== "chat-pro-repository-fable-outcome.v1"
        || sibling.task_id !== input.task_id || settled.task_id !== input.task_id
        || sibling.admission_key_sha256 !== sha256Hex(key) || settled.admission_key_sha256 !== sha256Hex(key)
        || typeof sibling.operation_id !== "string"
        || `${hashedDiskKey("fable-review-operation", sibling.operation_id)}.json` !== entry.name
        || typeof sibling.epoch_id !== "string" || !/^fable_epoch_[a-f0-9]{32}$/.test(sibling.epoch_id)
        || settled.operation_id !== sibling.operation_id || settled.epoch_id !== sibling.epoch_id
        || settled.provider_contact !== "NO" || settled.effect_disposition !== "NO_EXTERNAL_EFFECT") {
        throw new Error("STOP_MANAGED_RECOVERY_HISTORY_NOT_CLOSED");
      }
    }
    return { claim_sha256: sha256Hex(claimBytes), outcome_sha256: sha256Hex(outcomeBytes) };
  }

  async writeClaim(input: {
    task_id: string;
    admission_key: string;
    operation_id: string;
    epoch_id: string;
    packet_sha256: string;
    target: FableReviewEvidence["target"];
    launcher_sha256: string;
    router_sha256: string;
    recorded_at: string;
  }): Promise<void> {
    const paths = claimPaths(input.task_id, input.admission_key, input.operation_id);
    const unsigned = {
      schema: "chat-pro-repository-fable-claim.v1",
      task_id: input.task_id,
      admission_key_sha256: sha256Hex(input.admission_key),
      operation_id: input.operation_id,
      epoch_id: input.epoch_id,
      packet_sha256: input.packet_sha256,
      target: input.target,
      launcher_sha256: input.launcher_sha256,
      router_sha256: input.router_sha256,
      recorded_at: input.recorded_at
    };
    await writeExclusiveDigested(this.fs, paths.claim_path, unsigned);
  }

  async writeOutcome(input: {
    task_id: string;
    admission_key: string;
    operation_id: string;
    epoch_id: string;
    provider_contact: FableReviewEvidence["provider_contact"];
    effect_disposition: FableReviewEvidence["effect_disposition"];
    outcome_code: string;
    recorded_at: string;
  }): Promise<void> {
    const paths = claimPaths(input.task_id, input.admission_key, input.operation_id);
    const unsigned = {
      schema: "chat-pro-repository-fable-outcome.v1",
      task_id: input.task_id,
      admission_key_sha256: sha256Hex(input.admission_key),
      operation_id: input.operation_id,
      epoch_id: input.epoch_id,
      provider_contact: input.provider_contact,
      effect_disposition: input.effect_disposition,
      outcome_code: input.outcome_code,
      recorded_at: input.recorded_at
    };
    await writeExclusiveDigested(this.fs, paths.outcome_path, unsigned);
  }
}

function claimPaths(taskId: string, admissionKey: string, operationId: string) {
  const taskKey = hashedDiskKey("fable-review-task", taskId);
  const admissionHash = sha256Hex(admissionKey);
  const operationHash = hashedDiskKey("fable-review-operation", operationId);
  const root = posix.join("fable-reviews", taskKey, admissionHash);
  return {
    claim_directory: posix.join(root, "claims"),
    outcome_directory: posix.join(root, "outcomes"),
    claim_path: posix.join(root, "claims", `${operationHash}.json`),
    outcome_path: posix.join(root, "outcomes", `${operationHash}.json`)
  };
}

async function writeExclusiveDigested(
  fs: SecureRuntimeFs,
  path: string,
  unsigned: Record<string, unknown>
): Promise<void> {
  const value = {
    ...unsigned,
    record_sha256: canonicalSha256(unsigned)
  };
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  await fs.atomicWrite(path, bytes, { exclusive: true });
  const readBack = await fs.readFile(path, bytes.length);
  if (!readBack.equals(bytes)) throw new Error("STOP_MANAGED_EVIDENCE_READBACK_MISMATCH");
}

function parseDigestedRecord(bytes: Buffer, digestField: string): Record<string, unknown> {
  const value = asRecord(JSON.parse(bytes.toString("utf8")));
  const digest = value[digestField];
  if (typeof digest !== "string" || digestRecord(value, digestField) !== digest) {
    throw new Error("STOP_MANAGED_EVIDENCE_DIGEST_MISMATCH");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
