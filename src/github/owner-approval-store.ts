import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  GitHubBoundaryError,
  assertSafeIdentifier,
  canonicalJson,
  type Clock,
  type JsonValue,
  type RuntimeRootProvider
} from "./types.js";

export type OwnerMergeApproval = {
  approvalId: string;
  gateId: string;
  gateSha256: string;
  issuedAt: string;
  expiresAt: string;
  consumed: boolean;
  consumedAt?: string;
  consumedByOperationId?: string;
};

export interface OwnerApprovalVerifier {
  inspect(input: { approvalId: string; gateId: string; gateSha256: string }): Promise<OwnerMergeApproval>;
  claim(input: { approvalId: string; gateId: string; gateSha256: string; operationId: string }): Promise<OwnerMergeApproval>;
}

export interface OwnerApprovalIssuer {
  create(input: { gateId: string; gateSha256: string; ttlMs?: number }): Promise<OwnerMergeApproval>;
}

export interface ApprovalIdFactory {
  createOpaqueId(): string;
}

const randomApprovalIdFactory: ApprovalIdFactory = {
  createOpaqueId: () => randomBytes(24).toString("base64url")
};

export class OwnerApprovalStore implements OwnerApprovalVerifier, OwnerApprovalIssuer {
  constructor(
    private readonly runtimeRoot: RuntimeRootProvider,
    private readonly clock: Clock,
    private readonly idFactory: ApprovalIdFactory = randomApprovalIdFactory,
    private readonly defaultTtlMs = 10 * 60 * 1000
  ) {
    assertTtl(defaultTtlMs);
  }

  async create(input: { gateId: string; gateSha256: string; ttlMs?: number }): Promise<OwnerMergeApproval> {
    const gateId = assertGateId(input.gateId, input.gateSha256);
    const gateSha256 = assertDigest(input.gateSha256);
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    assertTtl(ttlMs);
    const approvalId = `merge_approval_${this.idFactory.createOpaqueId()}`;
    assertApprovalId(approvalId);
    const issuedAt = this.clock.now();
    const record: OwnerMergeApproval = {
      approvalId,
      gateId,
      gateSha256,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
      consumed: false
    };
    const directory = await this.approvalDirectory();
    await writeExclusiveFile(join(directory, `${approvalId}.json`), approvalRecordJson(record));
    await assertSecureFile(join(directory, `${approvalId}.json`));
    await syncDirectory(directory);
    return record;
  }

  async inspect(input: { approvalId: string; gateId: string; gateSha256: string }): Promise<OwnerMergeApproval> {
    const approvalId = assertApprovalId(input.approvalId);
    const gateId = assertGateId(input.gateId, input.gateSha256);
    const gateSha256 = assertDigest(input.gateSha256);
    const directory = await this.approvalDirectory();
    const approvalPath = join(directory, `${approvalId}.json`);
    const bytes = await readSecureFile(approvalPath, "APPROVAL_FILE_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new GitHubBoundaryError("APPROVAL_FILE_INVALID", "Owner approval record is not valid JSON.");
    }
    const record = parseApprovalRecord(parsed);
    if (`${canonicalJson(approvalRecordJson(record))}\n` !== bytes) {
      throw new GitHubBoundaryError("APPROVAL_FILE_NON_CANONICAL", "Owner approval record is not canonical.");
    }
    if (record.gateId !== gateId || record.gateSha256 !== gateSha256) {
      throw new GitHubBoundaryError("APPROVAL_BINDING_MISMATCH", "Owner approval does not match the exact gate digest.");
    }
    const claim = await readClaimIfPresent(directory, record);
    if (claim) return {
      ...record,
      consumed: true,
      consumedAt: claim.consumedAt,
      consumedByOperationId: claim.operationId
    };
    if (Date.parse(record.expiresAt) <= this.clock.now().getTime()) {
      throw new GitHubBoundaryError("APPROVAL_EXPIRED", "Owner approval has expired.");
    }
    return record;
  }

  async claim(input: { approvalId: string; gateId: string; gateSha256: string; operationId: string }): Promise<OwnerMergeApproval> {
    const operationId = assertSafeIdentifier(input.operationId, "merge operation id");
    const record = await this.inspect(input);
    if (record.consumed) throw new GitHubBoundaryError("APPROVAL_CONSUMED", "Owner approval was already consumed.");
    const directory = await this.approvalDirectory();
    const consumedAt = this.clock.now().toISOString();
    const claim: ApprovalClaim = {
      approvalId: record.approvalId,
      gateId: record.gateId,
      gateSha256: record.gateSha256,
      operationId,
      consumedAt
    };
    try {
      await writeExclusiveFile(join(directory, `${record.approvalId}.claim`), approvalClaimJson(claim));
      await assertSecureFile(join(directory, `${record.approvalId}.claim`));
      await syncDirectory(directory);
    } catch (error) {
      const observed = await readClaimIfPresent(directory, record).catch(() => undefined);
      if (!observed) throw error;
      if (observed.gateId !== record.gateId || observed.gateSha256 !== record.gateSha256) {
        throw new GitHubBoundaryError("APPROVAL_CLAIM_CONFLICT", "Owner approval claim has a conflicting exact binding.");
      }
      if (observed.operationId === operationId) {
        return {
          ...record,
          consumed: true,
          consumedAt: observed.consumedAt,
          consumedByOperationId: observed.operationId
        };
      }
      throw new GitHubBoundaryError("APPROVAL_CONSUMED", "Owner approval was already consumed.");
    }
    return { ...record, consumed: true, consumedAt, consumedByOperationId: operationId };
  }

  private async approvalDirectory(): Promise<string> {
    const root = await this.runtimeRoot.getRuntimeRoot();
    if (!isAbsolute(root)) throw new GitHubBoundaryError("RUNTIME_ROOT_NOT_ABSOLUTE", "Runtime root must be absolute.");
    const directory = join(root, "owner-merge-approvals");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (currentUid !== undefined && stat.uid !== currentUid)) {
      throw new GitHubBoundaryError("APPROVAL_DIRECTORY_UNSAFE", "Owner approval directory must be owner-only mode 0700.");
    }
    return directory;
  }
}

type ApprovalClaim = {
  approvalId: string;
  gateId: string;
  gateSha256: string;
  operationId: string;
  consumedAt: string;
};

async function writeExclusiveFile(path: string, value: JsonValue): Promise<void> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new GitHubBoundaryError("APPROVAL_ALREADY_EXISTS", "Owner approval record already exists.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function assertSecureFile(path: string): Promise<void> {
  const stat = await lstat(path);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
    || (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    throw new GitHubBoundaryError("APPROVAL_FILE_UNSAFE", "Owner approval record must be a single-link owner-only mode 0600 file.");
  }
}

async function readSecureFile(path: string, invalidCode: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (currentUid !== undefined && stat.uid !== currentUid)
      || stat.size <= 0
      || stat.size > 16_384
    ) {
      throw new GitHubBoundaryError(invalidCode, "Owner approval file violates the fixed secure-file boundary.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readClaimIfPresent(directory: string, record: OwnerMergeApproval): Promise<ApprovalClaim | undefined> {
  const path = join(directory, `${record.approvalId}.claim`);
  try {
    const bytes = await readSecureFile(path, "APPROVAL_CLAIM_INVALID");
    const parsed = parseApprovalClaim(JSON.parse(bytes) as unknown);
    if (`${canonicalJson(approvalClaimJson(parsed))}\n` !== bytes) {
      throw new GitHubBoundaryError("APPROVAL_CLAIM_INVALID", "Owner approval claim is not canonical.");
    }
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseApprovalRecord(value: unknown): OwnerMergeApproval {
  if (!isUnknownRecord(value)) throw new GitHubBoundaryError("APPROVAL_FILE_INVALID", "Owner approval record has an invalid fixed schema.");
  if (
    typeof value.approvalId !== "string"
    || typeof value.gateId !== "string"
    || typeof value.gateSha256 !== "string"
    || typeof value.issuedAt !== "string"
    || typeof value.expiresAt !== "string"
    || value.consumed !== false
    || Object.keys(value).sort().join(",") !== "approvalId,consumed,expiresAt,gateId,gateSha256,issuedAt"
  ) {
    throw new GitHubBoundaryError("APPROVAL_FILE_INVALID", "Owner approval record has an invalid fixed schema.");
  }
  return {
    approvalId: assertApprovalId(value.approvalId),
    gateId: assertGateId(value.gateId, value.gateSha256),
    gateSha256: assertDigest(value.gateSha256),
    issuedAt: assertTimestamp(value.issuedAt),
    expiresAt: assertTimestamp(value.expiresAt),
    consumed: false
  };
}

function parseApprovalClaim(value: unknown): ApprovalClaim {
  if (!isUnknownRecord(value)) throw new GitHubBoundaryError("APPROVAL_CLAIM_INVALID", "Owner approval claim has an invalid fixed schema.");
  if (
    typeof value.approvalId !== "string"
    || typeof value.gateId !== "string"
    || typeof value.gateSha256 !== "string"
    || typeof value.operationId !== "string"
    || typeof value.consumedAt !== "string"
    || Object.keys(value).sort().join(",") !== "approvalId,consumedAt,gateId,gateSha256,operationId"
  ) {
    throw new GitHubBoundaryError("APPROVAL_CLAIM_INVALID", "Owner approval claim has an invalid fixed schema.");
  }
  return {
    approvalId: assertApprovalId(value.approvalId),
    gateId: assertGateId(value.gateId, value.gateSha256),
    gateSha256: assertDigest(value.gateSha256),
    operationId: assertSafeIdentifier(value.operationId, "merge operation id"),
    consumedAt: assertTimestamp(value.consumedAt)
  };
}

function approvalRecordJson(record: OwnerMergeApproval): JsonValue {
  return {
    approvalId: record.approvalId,
    gateId: record.gateId,
    gateSha256: record.gateSha256,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    consumed: false
  };
}

function approvalClaimJson(claim: ApprovalClaim): JsonValue {
  return {
    approvalId: claim.approvalId,
    gateId: claim.gateId,
    gateSha256: claim.gateSha256,
    operationId: claim.operationId,
    consumedAt: claim.consumedAt
  };
}

function assertApprovalId(value: string): string {
  if (!/^merge_approval_[A-Za-z0-9_-]{16,160}$/.test(value)) {
    throw new GitHubBoundaryError("INVALID_APPROVAL_ID", "Owner approval id is invalid.");
  }
  return value;
}

function assertGateId(value: string, digest: string): string {
  assertSafeIdentifier(value, "gate id");
  if (value !== `merge_manifest_${assertDigest(digest)}`) {
    throw new GitHubBoundaryError("INVALID_GATE_ID", "Gate id is not bound to the exact gate digest.");
  }
  return value;
}

function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new GitHubBoundaryError("INVALID_GATE_DIGEST", "Gate digest is invalid.");
  return value;
}

function assertTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new GitHubBoundaryError("APPROVAL_FILE_INVALID", "Approval timestamp is invalid.");
  return value;
}

function assertTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60 * 60 * 1000) {
    throw new GitHubBoundaryError("INVALID_APPROVAL_TTL", "Owner approval TTL must be between one second and one hour.");
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
