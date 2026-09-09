import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type InstalledStaticPin = {
  readonly name: string;
  readonly byte_length: number | null;
  readonly sha256: string | null;
  readonly mode: 0o600 | 0o644 | 0o700 | null;
};

// Closed production support closure. These are not caller-selectable paths.
// Source cohort: router 3d6eab9e322f0414e0cb88925380f132e692df30.
// Resolver mode 0644 is preserved; the remaining modes are activation targets.
// This binds source expectations only. It never installs or rewrites bytes.
export const FABLE_STATIC_DEPENDENCY_PINS = [
  { name: "native_history_migration.py", byte_length: 66854, sha256: "51f0749cd5b78c5ab0954beb74c16f3df78ba991000a1e227906e077d549f620", mode: 0o700 },
  { name: "managed_missing_body_admission.py", byte_length: 29708, sha256: "516cc1db7a05c134e33a647303b8d4bccca038f482d7562802e9ef3e20084332", mode: 0o700 },
  { name: "task_prior_archive.py", byte_length: 9088, sha256: "77305071d2a5cb01ec255a20055182ae7d825c6d9ef07f7aca471432636ecfa1", mode: 0o700 },
  { name: "review_response_retention_bootstrap.py", byte_length: 140764, sha256: "fc235cb55230e0055b2be3ff8790bc12742d3f04d681b83fc0b95284d9fae958", mode: 0o700 },
  { name: "review_lineage_reconciliation.py", byte_length: 28795, sha256: "7d58b0778f2abe6f9d6796cc45acd01354f4a67fd59c74dc0923dc47f33f48c4", mode: 0o700 },
  { name: "route-policy.json", byte_length: 4626, sha256: "a6be2e9363bb36071cbf2be817ffba7167ea00c7444305637ba71f0c5178964a", mode: 0o600 },
  { name: "resolver_registry.py", byte_length: 22860, sha256: "bbc12e68b8a7eeb1a0142b23da1655a5ddbe22011c65f8a5a420f534fa1ddbb4", mode: 0o644 }
] as const satisfies readonly InstalledStaticPin[];

const MAX_STATIC_FILE_BYTES = 2 * 1024 * 1024;
const PIN_MISMATCH = "STOP_MANAGED_INSTALLED_BYTES_MISMATCH";

type ExpectedStaticBytes = Pick<InstalledStaticPin, "byte_length" | "sha256" | "mode">;

/** Internal byte checker only; no public root, executable, or pin selector. */
export async function assertPinnedStaticFile(path: string, expected: ExpectedStaticBytes): Promise<void> {
  try {
    if (expected.byte_length === null || !Number.isSafeInteger(expected.byte_length)
      || expected.byte_length <= 0 || expected.byte_length > MAX_STATIC_FILE_BYTES
      || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || ![0o600, 0o644, 0o700].includes(expected.mode ?? -1)
      || !constants.O_NOFOLLOW) {
      throw new Error(PIN_MISMATCH);
    }
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error(PIN_MISMATCH);
    const before = await lstat(path, { bigint: true });
    assertMetadata(before, expected, uid);
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(path, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      assertMetadata(opened, expected, uid);
      if (!sameIdentity(before, opened)) throw new Error(PIN_MISMATCH);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let consumed = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0,
          Math.min(buffer.length, expected.byte_length + 1 - consumed), consumed);
        if (bytesRead === 0) break;
        consumed += bytesRead;
        if (consumed > expected.byte_length) throw new Error(PIN_MISMATCH);
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      assertMetadata(after, expected, uid);
      assertMetadata(named, expected, uid);
      if (consumed !== expected.byte_length || hash.digest("hex") !== expected.sha256
        || !sameIdentity(opened, after) || !sameIdentity(after, named)) {
        throw new Error(PIN_MISMATCH);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Missing files and OS errors must not expose installed paths or raw errors.
    throw new Error(PIN_MISMATCH);
  }
}

function assertMetadata(metadata: BigIntStats, expected: ExpectedStaticBytes, uid: number): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || metadata.uid !== BigInt(uid) || (metadata.mode & 0o7777n) !== BigInt(expected.mode ?? -1)
    || metadata.size !== BigInt(expected.byte_length ?? -1)) {
    throw new Error(PIN_MISMATCH);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
