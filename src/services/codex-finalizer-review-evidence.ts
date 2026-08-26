import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { CodexReviewResult } from "../contracts/codex-task.contract.js";
import type { DelegationResultV3 } from "../contracts/delegation-v3.contract.js";
import { DelegationRunStore } from "../delegation/run-store.js";
import { readSafeRunArtifact } from "../delegation/safe-artifact.js";
import { runGitBounded } from "./git-exec.js";
import type { CodexRunManifest } from "./codex-run-manifest.js";
import { codexRunPaths } from "./codex-run-paths.js";

const MAX_STATE_BYTES = 128 * 1024;
const MAX_VALIDATION_BYTES = 512 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_GIT_BYTES = 32 * 1024 * 1024;
const FIXED_PROCESS_PATH = process.platform === "win32"
  ? process.env.PATH ?? ""
  : "/usr/bin:/bin";
const FIXED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const FIXED_GIT_CONFIG_ARGS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "maintenance.auto=false",
  "-c", `core.hooksPath=${FIXED_HOOKS_PATH}`,
  "-c", "submodule.recurse=false"
] as const;

const Sha40Schema = z.string().regex(/^[a-f0-9]{40}$/);
const Sha64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ArchiveEvidenceSchema = z.object({
  path: z.string().min(1).max(4_096).refine((value) => !/[\0\r\n]/.test(value)),
  byte_length: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  sha256: Sha64Schema,
  prefix: z.string().min(1).max(512).refine((value) => !/[\0\r\n]/.test(value)),
  regular_file_count: z.number().int().positive().max(1_000_000)
}).strict();
const FinalizerStateSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: z.string().min(1).max(200),
  operation_id: z.string().min(8).max(160),
  request_sha256: Sha64Schema,
  status: z.enum(["in_progress", "failed_before_commit", "partial_after_commit", "committed"]),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  head_before: Sha40Schema,
  head_after: Sha40Schema.nullable(),
  archive: ArchiveEvidenceSchema.nullable(),
  stop_reason: z.string().max(2_000).nullable()
}).strict();
const FinalizerValidationSchema = z.object({
  schema_version: z.literal(1),
  repo_id: z.string().min(1).max(200),
  run_id: z.string().min(1).max(200),
  operation_id: z.string().min(8).max(160),
  profile: z.literal("test"),
  command: z.string().min(1).max(2_000),
  tests_run: z.number().int().positive(),
  duration_ms: z.number().int().nonnegative(),
  output_sha256: Sha64Schema,
  stdout_tail: z.string().max(128 * 1024),
  stderr_tail: z.string().max(128 * 1024),
  completed_at: z.string().datetime()
}).strict();

type RegularTreeEntry = {
  path: string;
  mode: "100644" | "100755";
  object_id: string;
  size: number;
};

type ExactTarEntry = {
  path: string;
  mode: "100644" | "100755";
  size: number;
  sha256: string;
};

type FinalizerValidationBinding = NonNullable<CodexReviewResult["git_review"]>["ship_readiness"]["validation"];

type FinalizerReviewBinding = {
  branch: string;
  head_sha: string;
  review_fingerprint: string;
};

export type CodexFinalizerReviewEvidence =
  | { status: "not_applicable" }
  | ({ status: "invalid"; warning: FinalizerEvidenceWarning } & FinalizerReviewBinding)
  | ({
      status: "valid";
      changed_paths: string[];
      validation: FinalizerValidationBinding;
      archive: {
        sha256: string;
        byte_length: number;
        regular_file_count: number;
      };
    } & FinalizerReviewBinding);

type FinalizerEvidenceWarning =
  | "CODEX_FINALIZER_STATE_INVALID"
  | "CODEX_FINALIZER_RUNNER_STATUS_MISMATCH"
  | "CODEX_FINALIZER_COMMIT_MISMATCH"
  | "CODEX_FINALIZER_VALIDATION_MISMATCH"
  | "CODEX_FINALIZER_ARCHIVE_MISMATCH";

class FinalizerEvidenceError extends Error {
  constructor(readonly warning: FinalizerEvidenceWarning) {
    super(warning);
  }
}

export async function inspectCommittedFinalizerReviewEvidence(input: {
  root: string;
  repo_id: string;
  run_id: string;
  manifest: CodexRunManifest | undefined;
  result: DelegationResultV3 | undefined;
}): Promise<CodexFinalizerReviewEvidence> {
  if (input.manifest?.schema_version !== 3) return { status: "not_applicable" };
  const paths = codexRunPaths(input.run_id);
  const statePath = `${paths.runDir}/finalizer-state.json`;
  let stateText: string | undefined;
  let stateReadFailed = false;
  try {
    stateText = await readSafeRunArtifact(input.root, statePath, MAX_STATE_BYTES);
  } catch {
    stateText = "";
    stateReadFailed = true;
  }
  if (stateText === undefined) return { status: "not_applicable" };

  const [branch, currentHead] = await Promise.all([
    gitText(input.root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitText(input.root, ["rev-parse", "HEAD"])
  ]);
  if (stateReadFailed) {
    return invalidEvidence(
      "CODEX_FINALIZER_STATE_INVALID",
      branch,
      currentHead,
      stateText
    );
  }
  if (!input.result || input.result.status !== "completed") {
    return invalidEvidence(
      "CODEX_FINALIZER_STATE_INVALID",
      branch,
      currentHead,
      stateText
    );
  }

  try {
    const state = parseJson(FinalizerStateSchema, stateText, "CODEX_FINALIZER_STATE_INVALID");
    requireEvidence(
      state.repo_id === input.repo_id
      && state.run_id === input.run_id
      && state.status === "committed"
      && state.stop_reason === null
      && state.head_before === input.manifest.baseline.head_sha
      && state.head_after === currentHead
      && state.archive !== null,
      "CODEX_FINALIZER_STATE_INVALID"
    );
    const stagedPaths = await gitZeroList(
      input.root,
      ["diff", "--cached", "--name-only", "-z", "--"]
    );
    const untrackedPaths = await gitZeroList(
      input.root,
      ["ls-files", "--others", "-z", "--"]
    );
    requireEvidence(
      stagedPaths.length === 0
      && untrackedPaths.every((path) => path.startsWith(".chatgpt/")),
      "CODEX_FINALIZER_COMMIT_MISMATCH"
    );

    const expectedPaths = uniqueSorted(input.result.changed_files);
    requireEvidence(
      expectedPaths.length === input.result.changed_files.length
      && input.result.blockers.length === 0
      && input.result.followups.length === 0
      && input.result.scope_extension_required.length === 0,
      "CODEX_FINALIZER_STATE_INVALID"
    );

    const runStore = new DelegationRunStore(input.root);
    const status = await runStore.readStatus(input.run_id);
    const validationPath = `${paths.runDir}/finalizer-validation.json`;
    requireEvidence(
      status !== undefined
      && status.manifest_version === 3
      && status.repo_id === input.repo_id
      && status.run_id === input.run_id
      && status.status === "committed"
      && status.result_found
      && status.result_json_path === paths.resultJsonPath
      && status.head_before === input.manifest.baseline.head_sha
      && status.head_after === currentHead
      && status.worktree_fingerprint_after === "source-clean-control-artifacts-only"
      && sameStrings(status.changed_paths, expectedPaths)
      && status.commit.attempted
      && status.commit.allowed
      && status.commit.status === "committed"
      && status.commit.commit_sha === currentHead
      && status.validation.status === "passed"
      && status.validation.profile === "test"
      && status.validation.artifact_path === validationPath,
      "CODEX_FINALIZER_RUNNER_STATUS_MISMATCH"
    );
    const priorRevision = parsePriorRevision(status.warnings);
    requireEvidence(
      priorRevision !== undefined
      && status.revision === priorRevision + 1
      && status.warnings.includes("EXACT_RUN_FINALIZER=PASS")
      && status.warnings.includes("FINAL_PROVIDER_CONTACT=0")
      && status.warnings.includes("FINAL_MODEL_TURNS=0"),
      "CODEX_FINALIZER_RUNNER_STATUS_MISMATCH"
    );

    let validationText: string | undefined;
    try {
      validationText = await readSafeRunArtifact(input.root, validationPath, MAX_VALIDATION_BYTES);
    } catch {
      throw new FinalizerEvidenceError("CODEX_FINALIZER_VALIDATION_MISMATCH");
    }
    requireEvidence(validationText !== undefined, "CODEX_FINALIZER_VALIDATION_MISMATCH");
    const validation = parseJson(
      FinalizerValidationSchema,
      validationText,
      "CODEX_FINALIZER_VALIDATION_MISMATCH"
    );
    requireEvidence(
      input.manifest.task.validation?.profile === "test"
      && input.manifest.task.validation.test_paths.length === 0
      && validation.repo_id === input.repo_id
      && validation.run_id === input.run_id
      && validation.operation_id === state.operation_id
      && status.warnings.includes(`FINAL_VALIDATION_TESTS=${validation.tests_run}`),
      "CODEX_FINALIZER_VALIDATION_MISMATCH"
    );

    const parents = (await gitText(input.root, ["rev-list", "--parents", "-n", "1", currentHead]))
      .trim()
      .split(/\s+/);
    requireEvidence(
      parents.length === 2
      && parents[0] === currentHead
      && parents[1] === input.manifest.baseline.head_sha,
      "CODEX_FINALIZER_COMMIT_MISMATCH"
    );
    const rawCommit = await gitText(input.root, ["cat-file", "commit", currentHead]);
    requireEvidence(!`\n${rawCommit}`.includes("\ngpgsig "), "CODEX_FINALIZER_COMMIT_MISMATCH");
    const committedPaths = await gitZeroList(
      input.root,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", currentHead]
    );
    requireEvidence(sameStrings(committedPaths, expectedPaths), "CODEX_FINALIZER_COMMIT_MISMATCH");

    const treeEntries = await readRegularTree(input.root, currentHead);
    await verifyArchive(input.root, input.repo_id, currentHead, state.archive, treeEntries);
    requireEvidence(
      status.warnings.includes(`ARCHIVE_PATH=${state.archive.path}`)
      && status.warnings.includes(`ARCHIVE_BYTES=${state.archive.byte_length}`)
      && status.warnings.includes(`ARCHIVE_SHA256=${state.archive.sha256}`)
      && status.warnings.includes(`ARCHIVE_PREFIX=${state.archive.prefix}`),
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );

    return {
      status: "valid",
      branch,
      head_sha: currentHead,
      review_fingerprint: reviewFingerprint([
        state.request_sha256,
        state.operation_id,
        currentHead,
        validation.output_sha256,
        state.archive.sha256,
        ...expectedPaths
      ]),
      changed_paths: expectedPaths,
      validation: {
        status: "passed",
        validation_status: "passed",
        profile: validation.profile,
        head_sha: currentHead,
        worktree_fingerprint: "clean",
        artifact_path: validationPath
      },
      archive: {
        sha256: state.archive.sha256,
        byte_length: state.archive.byte_length,
        regular_file_count: state.archive.regular_file_count
      }
    };
  } catch (error) {
    return invalidEvidence(
      error instanceof FinalizerEvidenceError
        ? error.warning
        : "CODEX_FINALIZER_STATE_INVALID",
      branch,
      currentHead,
      stateText
    );
  }
}

function invalidEvidence(
  warning: FinalizerEvidenceWarning,
  branch: string,
  headSha: string,
  stateText: string
): Extract<CodexFinalizerReviewEvidence, { status: "invalid" }> {
  return {
    status: "invalid",
    warning,
    branch,
    head_sha: headSha,
    review_fingerprint: reviewFingerprint([
      warning,
      branch,
      headSha,
      sha256(Buffer.from(stateText, "utf8"))
    ])
  };
}

async function verifyArchive(
  root: string,
  repoId: string,
  commitSha: string,
  archive: z.infer<typeof ArchiveEvidenceSchema>,
  treeEntries: RegularTreeEntry[]
): Promise<void> {
  const short = commitSha.slice(0, 12);
  const safeRepoId = repoId.replace(/[^A-Za-z0-9._-]/g, "-");
  const expectedPrefix = `${safeRepoId}-${short}/`;
  const expectedName = new RegExp(
    `^${escapeRegExp(safeRepoId)}-${short}-[a-z0-9][a-z0-9-]{0,79}\\.tar$`
  );
  requireEvidence(
    isAbsolute(archive.path)
    && archive.prefix === expectedPrefix
    && expectedName.test(basename(archive.path))
    && archive.regular_file_count === treeEntries.length,
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );
  const archiveStat = await lstat(archive.path).catch(() => {
    throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
  });
  requireEvidence(
    archiveStat.isFile() && !archiveStat.isSymbolicLink(),
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );
  const archiveReal = await realpath(archive.path).catch(() => {
    throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
  });
  const allowedRoots = await temporaryRoots();
  requireEvidence(
    allowedRoots.some((allowedRoot) => isWithin(allowedRoot, archiveReal)),
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(archiveReal, fsConstants.O_RDONLY | noFollow).catch(() => {
    throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
  });
  let data: Buffer;
  try {
    const before = await handle.stat();
    requireEvidence(
      before.isFile()
      && before.size === archive.byte_length
      && before.size > 0
      && before.size <= MAX_ARCHIVE_BYTES,
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );
    data = await handle.readFile();
    const after = await handle.stat();
    requireEvidence(
      before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && data.length === archive.byte_length,
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );
  } finally {
    await handle.close();
  }
  requireEvidence(sha256(data) === archive.sha256, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
  const parsed = parseExactTar(data, archive.prefix);
  requireEvidence(parsed.length === treeEntries.length, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
  const parsedByPath = new Map(parsed.map((entry) => [entry.path, entry]));
  const objectFormat = await gitText(root, ["rev-parse", "--show-object-format"]);
  requireEvidence(objectFormat === "sha1" || objectFormat === "sha256", "CODEX_FINALIZER_COMMIT_MISMATCH");
  for (const entry of treeEntries) {
    const archived = parsedByPath.get(entry.path);
    const bytes = await readWorktreeRegularFile(root, entry.path, entry.mode);
    requireEvidence(
      archived !== undefined
      && archived.mode === entry.mode
      && archived.size === entry.size
      && archived.sha256 === sha256(bytes)
      && gitBlobObjectId(bytes, objectFormat) === entry.object_id,
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );
  }
  for (const sidecar of [
    `${archive.path}.sha256`,
    archive.path.replace(/\.tar$/, ".sha256"),
    `${archive.path}.json`
  ]) {
    try {
      await lstat(sidecar);
      throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
    } catch (error) {
      if (error instanceof FinalizerEvidenceError) throw error;
      if (!hasCode(error, "ENOENT")) throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
    }
  }
}

async function readRegularTree(root: string, commitSha: string): Promise<RegularTreeEntry[]> {
  const output = await gitText(root, ["ls-tree", "-rz", "--full-tree", "-l", commitSha]);
  const entries: RegularTreeEntry[] = [];
  for (const record of output.split("\0").filter(Boolean)) {
    const match = record.match(/^(\d{6})\s+(\w+)\s+([a-f0-9]{40,64})\s+(\d+|-)\t(.+)$/s);
    requireEvidence(match !== null, "CODEX_FINALIZER_COMMIT_MISMATCH");
    const mode = match[1];
    const type = match[2];
    const objectId = match[3];
    const sizeText = match[4];
    const path = match[5];
    requireEvidence(
      (mode === "100644" || mode === "100755")
      && type === "blob"
      && sizeText !== undefined
      && sizeText !== "-"
      && path !== undefined,
      "CODEX_FINALIZER_COMMIT_MISMATCH"
    );
    assertSafeArchiveRelativePath(path);
    const size = Number.parseInt(sizeText, 10);
    requireEvidence(Number.isSafeInteger(size) && size >= 0, "CODEX_FINALIZER_COMMIT_MISMATCH");
    entries.push({
      path,
      mode,
      object_id: objectId!,
      size
    } as RegularTreeEntry);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function readWorktreeRegularFile(
  root: string,
  path: string,
  expectedMode: "100644" | "100755"
): Promise<Buffer> {
  assertSafeArchiveRelativePath(path);
  let current = root;
  for (const [index, part] of path.split("/").entries()) {
    current = join(current, part);
    const entryStat = await lstat(current).catch(() => {
      throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH");
    });
    requireEvidence(!entryStat.isSymbolicLink(), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    if (index < path.split("/").length - 1) {
      requireEvidence(entryStat.isDirectory(), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    } else {
      requireEvidence(entryStat.isFile(), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    }
  }
  const absolute = join(root, path);
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(absolute)]);
  requireEvidence(isWithin(rootReal, targetReal), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    const actualMode: "100644" | "100755" = process.platform === "win32"
      ? expectedMode
      : (before.mode & 0o111) === 0 ? "100644" : "100755";
    requireEvidence(before.isFile() && actualMode === expectedMode, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    requireEvidence(
      before.dev === after.dev
      && before.ino === after.ino
      && before.size === after.size
      && after.size === bytes.length,
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseExactTar(data: Buffer, expectedPrefix: string): ExactTarEntry[] {
  requireEvidence(
    data.length > 0 && data.length % 512 === 0 && data.length <= MAX_ARCHIVE_BYTES,
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );
  const entries: ExactTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    requireEvidence(zeroBlocks === 0, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    const storedChecksum = tarOctal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    requireEvidence(storedChecksum === actualChecksum, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    const name = tarString(header.subarray(0, 100));
    const headerPrefix = tarString(header.subarray(345, 500));
    const fullName = headerPrefix ? `${headerPrefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const numericMode = tarOctal(header.subarray(100, 108));
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    requireEvidence(
      typeFlag === "0" && fullName.startsWith(expectedPrefix),
      "CODEX_FINALIZER_ARCHIVE_MISMATCH"
    );
    const path = fullName.slice(expectedPrefix.length);
    assertSafeArchiveRelativePath(path);
    requireEvidence(!seen.has(path), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    seen.add(path);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    requireEvidence(contentEnd <= data.length, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
    const mode: "100644" | "100755" = numericMode === 0o755
      ? "100755"
      : numericMode === 0o644
        ? "100644"
        : (() => { throw new FinalizerEvidenceError("CODEX_FINALIZER_ARCHIVE_MISMATCH"); })();
    const content = data.subarray(contentStart, contentEnd);
    entries.push({ path, mode, size, sha256: sha256(content) });
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  requireEvidence(
    zeroBlocks === 2 && data.subarray(offset).every((byte) => byte === 0),
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function tarString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function tarOctal(value: Buffer): number {
  const text = tarString(value).trim().replace(/^0+/, "") || "0";
  requireEvidence(/^[0-7]+$/.test(text), "CODEX_FINALIZER_ARCHIVE_MISMATCH");
  const parsed = Number.parseInt(text, 8);
  requireEvidence(Number.isSafeInteger(parsed) && parsed >= 0, "CODEX_FINALIZER_ARCHIVE_MISMATCH");
  return parsed;
}

function assertSafeArchiveRelativePath(path: string): void {
  requireEvidence(
    path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !Array.from(path).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git"),
    "CODEX_FINALIZER_ARCHIVE_MISMATCH"
  );
}

async function temporaryRoots(): Promise<string[]> {
  const roots = [...new Set([tmpdir(), "/private/tmp", "/tmp"].map((path) => resolve(path)))];
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(await realpath(root));
    } catch {
      continue;
    }
  }
  return resolved;
}

async function gitText(root: string, args: string[]): Promise<string> {
  const result = await runGitBounded({
    root,
    args: [...FIXED_GIT_CONFIG_ARGS, "--no-replace-objects", ...args],
    max_stdout_bytes: MAX_GIT_BYTES,
    env: gitEnvironment()
  });
  return result.stdout.replace(/\n$/, "");
}

async function gitZeroList(root: string, args: string[]): Promise<string[]> {
  return uniqueSorted((await gitText(root, args)).split("\0").filter(Boolean));
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: FIXED_PROCESS_PATH,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C"
  };
}

function gitBlobObjectId(bytes: Buffer, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function parsePriorRevision(warnings: readonly string[]): number | undefined {
  const matches = warnings
    .map((warning) => warning.match(/^PRIOR_TERMINAL_REVISION=(\d+)$/)?.[1])
    .filter((value): value is string => value !== undefined);
  if (matches.length !== 1) return undefined;
  const revision = Number.parseInt(matches[0]!, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function parseJson<T>(
  schema: z.ZodType<T>,
  text: string,
  warning: FinalizerEvidenceWarning
): T {
  try {
    return schema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new FinalizerEvidenceError(warning);
  }
}

function requireEvidence(
  condition: unknown,
  warning: FinalizerEvidenceWarning
): asserts condition {
  if (!condition) throw new FinalizerEvidenceError(warning);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = uniqueSorted(left);
  const normalizedRight = uniqueSorted(right);
  return normalizedLeft.length === left.length
    && normalizedRight.length === right.length
    && normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function reviewFingerprint(values: readonly string[]): string {
  return sha256(Buffer.from(JSON.stringify(values), "utf8"));
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
