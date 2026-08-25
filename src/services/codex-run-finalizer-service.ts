import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  DelegationResultV3Schema,
  type DelegationResultV3,
  type DelegationRunManifestV3
} from "../contracts/delegation-v3.contract.js";
import type {
  RepoFinalizeCodexRunInput,
  RepoFinalizeCodexRunResult
} from "../contracts/codex-run-finalizer.contract.js";
import type { AgentRunnerStatus } from "../delegation/artifact-contracts.js";
import { DelegationRunStore } from "../delegation/run-store.js";
import {
  assertSafeRunDirectory,
  readSafeRunArtifact,
  writeSafeRunJson
} from "../delegation/safe-artifact.js";
import { RepoReaderError } from "../runtime/errors.js";
import {
  atomicWriteJson,
  isAlreadyExistsError,
  isNotFoundError,
  writeExclusiveJson
} from "../runtime/fs-helpers.js";
import { redactSensitiveText } from "../runtime/result-envelope.js";
import { evaluateCodexRunIntegrity } from "./codex-run-integrity.js";
import { codexRunPaths } from "./codex-run-paths.js";
import { matchesGlob } from "./glob-service.js";
import {
  assertRealPathWithinRoot,
  isAllowedEnvTemplatePath,
  isHardSecretPath
} from "./git-operation-safety.js";
import { parseDelegationResultV3 } from "./delegation-v3-normalizer.js";
import { runProcessWithTail } from "./process-exec.js";
import { SecretScanner } from "./secret-scanner.js";

const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
const MAX_GIT_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_VALIDATION_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_WALK_ENTRIES = 100_000;
const GIT_EXECUTABLE = process.platform === "win32" ? "git" : "/usr/bin/git";
const FIXED_PROCESS_PATH = process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin";

const TERMINAL_PRECOMMIT_STATUSES = new Set(["failed", "timed_out", "blocked_verification"]);

export type CodexRunFinalizerValidation = {
  profile: "test";
  command: string;
  tests_run: number;
  duration_ms: number;
  output_sha256: string;
  stdout_tail: string;
  stderr_tail: string;
};

export type CodexRunFinalizerOptions = {
  now?: () => Date;
  archive_root?: string;
  python_candidates?: string[];
  validate?: (input: {
    root: string;
    manifest: DelegationRunManifestV3;
    changed_paths: string[];
  }) => Promise<CodexRunFinalizerValidation>;
};

type ArchiveEvidence = {
  path: string;
  byte_length: number;
  sha256: string;
  prefix: string;
  regular_file_count: number;
};

type FinalizerState = {
  schema_version: 1;
  repo_id: string;
  run_id: string;
  operation_id: string;
  request_sha256: string;
  status: "in_progress" | "failed_before_commit" | "partial_after_commit" | "committed";
  started_at: string;
  updated_at: string;
  head_before: string;
  head_after: string | null;
  archive: ArchiveEvidence | null;
  stop_reason: string | null;
};

type GitResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

export class CodexRunFinalizerService {
  private readonly now: () => Date;
  private readonly archiveRoot: string;
  private readonly pythonCandidates: string[];
  private readonly customValidation?: CodexRunFinalizerOptions["validate"];
  private readonly runStore: DelegationRunStore;
  private readonly secretScanner = new SecretScanner();

  constructor(private readonly root: string, options: CodexRunFinalizerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.archiveRoot = options.archive_root ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir());
    this.pythonCandidates = options.python_candidates ?? [
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3"
    ];
    this.customValidation = options.validate;
    this.runStore = new DelegationRunStore(root, { now: this.now });
  }

  async finalize(input: RepoFinalizeCodexRunInput): Promise<RepoFinalizeCodexRunResult> {
    const paths = codexRunPaths(input.run_id);
    const statePath = `${paths.runDir}/finalizer-state.json`;
    const validationPath = `${paths.runDir}/finalizer-validation.json`;
    const requestSha256 = canonicalInputSha256(input);
    await assertSafeRunDirectory(this.root, paths.runDir);

    const existing = await this.readExistingSuccess(input, statePath, validationPath);
    if (existing) return existing;

    const loaded = await this.loadBoundRun(input);
    const preflight = await this.verifyPreflight(input, loaded.manifest, loaded.status);

    if (input.dry_run) {
      const validation = await this.runValidation(loaded.manifest, preflight.changedPaths);
      await this.verifySourceHashes(input, preflight.changedPaths);
      await this.verifyPostValidationGit(input, preflight.changedPaths);
      return {
        ok: true,
        dry_run: true,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        run_id: input.run_id,
        status: "validated",
        head_before: input.expected_head_sha,
        changed_paths: preflight.changedPaths,
        validation: publicValidation(validation, null),
        archive: null,
        result_json_path: paths.resultJsonPath,
        runner_status_path: `${paths.runDir}/runner.status.json`,
        warnings: ["EXACT_RUN_FINALIZER_DRY_RUN", "NO_SOURCE_OR_GIT_MUTATION"]
      };
    }

    const startedAt = this.now().toISOString();
    await this.acquireState(statePath, {
      schema_version: 1,
      repo_id: input.repo_id,
      run_id: input.run_id,
      operation_id: input.operation_id,
      status: "in_progress",
      request_sha256: requestSha256,
      started_at: startedAt,
      updated_at: startedAt,
      head_before: input.expected_head_sha,
      head_after: null,
      archive: null,
      stop_reason: null
    });

    let commitSha: string | undefined;
    let archive: ArchiveEvidence | undefined;
    try {
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "validation_started",
        summary: "Exact-run finalizer started fixed provider-free validation."
      });
      const validation = await this.runValidation(loaded.manifest, preflight.changedPaths);
      await this.verifySourceHashes(input, preflight.changedPaths);
      await this.verifyPostValidationGit(input, preflight.changedPaths);
      await writeSafeRunJson(this.root, validationPath, {
        schema_version: 1,
        repo_id: input.repo_id,
        run_id: input.run_id,
        operation_id: input.operation_id,
        profile: validation.profile,
        command: validation.command,
        tests_run: validation.tests_run,
        duration_ms: validation.duration_ms,
        output_sha256: validation.output_sha256,
        stdout_tail: redactSensitiveText(validation.stdout_tail).slice(-64_000),
        stderr_tail: redactSensitiveText(validation.stderr_tail).slice(-64_000),
        completed_at: this.now().toISOString()
      });
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "validation_completed",
        summary: `Exact-run finalizer validation passed ${validation.tests_run} tests.`
      });

      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "commit_started",
        summary: "Exact manifest-authorized stage and unsigned commit started."
      });
      commitSha = await this.commit(input, preflight.changedPaths);
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "commit_completed",
        summary: `Exact local commit created: ${commitSha}.`
      });

      archive = await this.createArchive(input, commitSha, preflight.trackedPaths);
      const result = this.buildResult(input, loaded.manifest, preflight.changedPaths, validation, commitSha, archive);
      DelegationResultV3Schema.parse(result);
      await writeSafeRunJson(this.root, paths.resultJsonPath, result);
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "result_detected",
        summary: "Exact-run finalizer wrote and validated RESULT.json."
      });

      const completedAt = this.now().toISOString();
      const warnings = terminalWarnings(input, loaded.status, validation, archive);
      await this.runStore.writeStatus({
        manifest_version: 3,
        review_requirement: "technical_only",
        repo_id: input.repo_id,
        run_id: input.run_id,
        runner: loaded.status.runner,
        status: "committed",
        revision: loaded.status.revision + 1,
        started_at: loaded.status.started_at,
        completed_at: completedAt,
        prompt_path: paths.promptPath,
        result_json_path: paths.resultJsonPath,
        result_found: true,
        head_before: input.expected_head_sha,
        head_after: commitSha,
        worktree_fingerprint_before: loaded.status.worktree_fingerprint_before,
        worktree_fingerprint_after: "source-clean-control-artifacts-only",
        changed_paths: preflight.changedPaths,
        validation: {
          status: "passed",
          profile: validation.profile,
          artifact_path: validationPath
        },
        commit: {
          attempted: true,
          allowed: true,
          status: "committed",
          commit_sha: commitSha
        },
        review: {
          repo_codex_review: { repo_id: input.repo_id, run_id: input.run_id },
          instructions: [
            "Verify exact Delegation v3 scope, Git binding, RESULT.json, and finalizer validation evidence.",
            "Treat .chatgpt run-control artifacts as local lifecycle state, not source changes.",
            "Verify the committed-source archive metadata from runner warnings."
          ]
        },
        warnings
      });
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "completed",
        summary: "Exact-run validation, commit, archive, RESULT.json, and terminal read-back completed."
      });
      await this.writeState(statePath, {
        schema_version: 1,
        repo_id: input.repo_id,
        run_id: input.run_id,
        operation_id: input.operation_id,
        status: "committed",
        request_sha256: requestSha256,
        started_at: startedAt,
        updated_at: completedAt,
        head_before: input.expected_head_sha,
        head_after: commitSha,
        archive,
        stop_reason: null
      });

      await this.verifySuccessReadback(input, preflight.changedPaths, commitSha, archive, paths.resultJsonPath);
      return {
        ok: true,
        dry_run: false,
        operation_id: input.operation_id,
        repo_id: input.repo_id,
        run_id: input.run_id,
        status: "committed",
        head_before: input.expected_head_sha,
        head_after: commitSha,
        commit_sha: commitSha,
        changed_paths: preflight.changedPaths,
        validation: publicValidation(validation, validationPath),
        archive,
        result_json_path: paths.resultJsonPath,
        runner_status_path: `${paths.runDir}/runner.status.json`,
        warnings
      };
    } catch (error) {
      const currentHead = await this.gitText(["rev-parse", "HEAD"]).catch(() => "UNKNOWN");
      const afterCommit = currentHead !== input.expected_head_sha;
      const reason = sanitizeError(error);
      if (!afterCommit) {
        await this.restoreIndex(preflight.changedPaths).catch(() => undefined);
      }
      const failedAt = this.now().toISOString();
      await this.writeState(statePath, {
        schema_version: 1,
        repo_id: input.repo_id,
        run_id: input.run_id,
        operation_id: input.operation_id,
        status: afterCommit ? "partial_after_commit" : "failed_before_commit",
        request_sha256: requestSha256,
        started_at: startedAt,
        updated_at: failedAt,
        head_before: input.expected_head_sha,
        head_after: afterCommit ? currentHead : null,
        archive: archive ?? null,
        stop_reason: reason
      }).catch(() => undefined);
      if (afterCommit) {
        await this.writeFailureStatus(input, loaded.status, validationPath, currentHead, reason).catch(() => undefined);
      }
      await this.runStore.appendEvent({
        repo_id: input.repo_id,
        run_id: input.run_id,
        event_type: "failed",
        summary: `Exact-run finalizer stopped ${afterCommit ? "after commit" : "before commit"}: ${reason}`
      }).catch(() => undefined);
      if (afterCommit) {
        throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Exact-run finalizer stopped after the local commit. Do not replay; read back the run and Git state.", {
          diagnostics: { run_id: input.run_id, head_after: currentHead, stop_reason: reason }
        });
      }
      throw error;
    }
  }

  private async loadBoundRun(input: RepoFinalizeCodexRunInput): Promise<{
    manifest: DelegationRunManifestV3;
    status: AgentRunnerStatus;
  }> {
    const record = await this.runStore.readRun(input.run_id);
    if (record.repo_id !== input.repo_id || record.manifest.schema_version !== 3) {
      throw new RepoReaderError("VALIDATION_ERROR", "Exact-run finalization requires the requested Delegation v3 repository and run.");
    }
    const manifest = record.manifest;
    if (
      manifest.task_kind !== "technical_infrastructure"
      || manifest.task.task_kind !== "technical_infrastructure"
      || manifest.review_requirement !== "technical_only"
      || manifest.product_binding.kind !== "not_required"
    ) {
      throw new RepoReaderError("VALIDATION_ERROR", "Exact-run finalizer v1 supports technical_infrastructure runs only.");
    }
    const prompt = await readSafeRunArtifact(this.root, record.prompt_path, MAX_PROMPT_BYTES);
    const integrity = evaluateCodexRunIntegrity(manifest, prompt, {
      resultPath: codexRunPaths(input.run_id).resultPath,
      resultJsonPath: record.result_json_path
    });
    if (!integrity.integrity.manifest_bound) {
      throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Delegation v3 prompt or manifest integrity is not bound.", {
        diagnostics: { warnings: integrity.warnings }
      });
    }
    const existingResult = await readSafeRunArtifact(this.root, record.result_json_path, MAX_RESULT_BYTES);
    if (existingResult !== undefined) {
      throw new RepoReaderError("TASK_OPERATION_ALREADY_COMPLETED", "RESULT.json already exists for this run.");
    }
    const status = await this.runStore.readStatus(input.run_id);
    if (!status || status.repo_id !== input.repo_id || status.run_id !== input.run_id) {
      throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Exact-run finalization requires a bound prior runner status.");
    }
    if (
      status.status !== input.expected_prior_status
      || status.revision !== input.expected_prior_status_revision
      || !TERMINAL_PRECOMMIT_STATUSES.has(status.status)
      || status.result_found
      || status.commit.attempted
      || status.commit.status !== "skipped"
      || status.head_after !== null
    ) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Prior runner status does not match the exact pre-commit terminal binding.", {
        diagnostics: {
          expected_status: input.expected_prior_status,
          actual_status: status.status,
          expected_revision: input.expected_prior_status_revision,
          actual_revision: status.revision
        }
      });
    }
    return { manifest, status };
  }

  private async verifyPreflight(
    input: RepoFinalizeCodexRunInput,
    manifest: DelegationRunManifestV3,
    status: AgentRunnerStatus
  ): Promise<{ changedPaths: string[]; trackedPaths: string[] }> {
    if (
      manifest.baseline.head_sha !== input.expected_head_sha
      || status.head_before !== input.expected_head_sha
    ) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Manifest, status, and requested HEAD bindings do not match.");
    }
    const [branch, head, tree] = await Promise.all([
      this.gitText(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.gitText(["rev-parse", "HEAD"]),
      this.gitText(["rev-parse", "HEAD^{tree}"])
    ]);
    if (branch !== input.expected_branch) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current branch does not match expected_branch.", {
        diagnostics: { expected_branch: input.expected_branch, branch }
      });
    }
    if (head !== input.expected_head_sha) {
      throw new RepoReaderError("GIT_HEAD_MISMATCH", "Current HEAD does not match expected_head_sha.", {
        diagnostics: { expected_head_sha: input.expected_head_sha, head_sha: head }
      });
    }
    if (tree !== input.expected_tree_sha) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Current tree does not match expected_tree_sha.", {
        diagnostics: { expected_tree_sha: input.expected_tree_sha, tree_sha: tree }
      });
    }
    await this.verifyAbsentRefs(input.expected_absent_refs);
    const remotes = await this.gitLineList(["remote"]);
    if (!sameStrings(remotes, input.expected_remote_names)) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Remote-name set does not match the exact expected local state.", {
        diagnostics: { expected_remote_names: input.expected_remote_names, remote_names: remotes }
      });
    }
    await this.assertNoGitOperation();
    const trackedPaths = await this.gitZeroList(["ls-files", "-z"]);
    if (trackedPaths.length !== input.expected_tracked_path_count) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Tracked-path count does not match the exact finalizer binding.", {
        diagnostics: { expected: input.expected_tracked_path_count, actual: trackedPaths.length }
      });
    }
    const changedPaths = await this.gitZeroList(["diff", "--name-only", "-z", "--"]);
    const expectedPaths = input.expected_changed_files.map(({ path }) => path).sort((a, b) => a.localeCompare(b));
    if (!sameStrings(changedPaths, expectedPaths)) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Tracked changed-path set does not match expected_changed_files.", {
        diagnostics: { expected_paths: expectedPaths, actual_paths: changedPaths }
      });
    }
    if ((await this.gitZeroList(["diff", "--cached", "--name-only", "-z", "--"])).length > 0) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Index must be clean before exact-run finalization.");
    }
    if ((await this.gitText(["diff", "--summary", "--"])).length > 0) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Exact-run finalizer refuses create, delete, rename, or mode changes.");
    }
    await this.assertStatusSurface(expectedPaths);
    for (const file of input.expected_changed_files) {
      if (!manifest.authorization.effective_scope.some((pattern) => matchesGlob(file.path, pattern))) {
        throw new RepoReaderError("TASK_OPERATION_BLOCKED", `Changed path is outside manifest authorization: ${file.path}`);
      }
      if (manifest.authorization.effective_forbidden_paths.some((pattern) => matchesGlob(file.path, pattern))) {
        throw new RepoReaderError("TASK_OPERATION_BLOCKED", `Changed path is forbidden by the manifest: ${file.path}`);
      }
      await this.assertSafeChangedFile(file.path, file.sha256, input.expected_head_sha);
    }
    return { changedPaths: expectedPaths, trackedPaths };
  }

  private async runValidation(
    manifest: DelegationRunManifestV3,
    changedPaths: string[]
  ): Promise<CodexRunFinalizerValidation> {
    if (this.customValidation) return this.customValidation({ root: this.root, manifest, changed_paths: changedPaths });
    const validation = manifest.task.validation;
    if (!validation || validation.profile !== "test" || validation.test_paths.length !== 0) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Exact-run finalizer v1 requires manifest validation profile=test with no caller-selected test paths.");
    }
    const pyproject = await readFile(join(this.root, "pyproject.toml"), "utf8").catch(() => "");
    if (!/^\[tool\.unittest\]$/m.test(pyproject)) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Exact-run finalizer v1 requires a repository-owned [tool.unittest] contract.");
    }
    const python = await this.resolvePython();
    await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
    const controlRoot = await mkdtemp(join(this.archiveRoot, "chat-pro-exact-run-validation-"));
    const home = join(controlRoot, "home");
    const temp = join(controlRoot, "tmp");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(temp, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: `${dirname(python)}${delimiter}/usr/bin${delimiter}/bin`,
      HOME: home,
      TMPDIR: temp,
      LANG: "C",
      LC_ALL: "C",
      CI: "1",
      NO_COLOR: "1",
      PYTHONPATH: "src",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PIP_NO_INDEX: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0"
    };
    try {
      const result = await runProcessWithTail({
        executable: python,
        args: ["-B", "-m", "unittest", "discover", "-v"],
        cwd: this.root,
        env,
        timeout_ms: 420_000,
        tail_bytes: 128 * 1024,
        capture_bytes: MAX_VALIDATION_CAPTURE_BYTES
      });
      const captured = result.captured_output ?? { stdout: result.stdout_tail, stderr: result.stderr_tail, truncated: false };
      const combined = `${captured.stdout}\n${captured.stderr}`;
      const match = combined.match(/Ran\s+(\d+)\s+tests?/);
      if (result.timed_out || result.exit_code !== 0 || !match || Number(match[1]) <= 0 || captured.truncated) {
        throw new RepoReaderError("VALIDATION_ERROR", "Fixed unittest validation failed, timed out, or exceeded its capture bound.", {
          diagnostics: {
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            stdout_tail: redactSensitiveText(result.stdout_tail),
            stderr_tail: redactSensitiveText(result.stderr_tail),
            capture_truncated: captured.truncated
          }
        });
      }
      const diffCheck = await this.git(["diff", "--check", "--"]);
      if (diffCheck.stdout.length > 0 || diffCheck.stderr.length > 0) {
        throw new RepoReaderError("VALIDATION_ERROR", "git diff --check returned unexpected output.");
      }
      const generated = await findPythonArtifacts(this.root);
      if (generated.length > 0) {
        throw new RepoReaderError("VALIDATION_ERROR", "Validation created Python bytecode inside the repository.", {
          diagnostics: { generated_paths: generated.slice(0, 20) }
        });
      }
      return {
        profile: "test",
        command: `${python} -B -m unittest discover -v`,
        tests_run: Number(match[1]),
        duration_ms: result.duration_ms,
        output_sha256: sha256(Buffer.from(`${captured.stdout}\n${captured.stderr}`, "utf8")),
        stdout_tail: result.stdout_tail,
        stderr_tail: result.stderr_tail
      };
    } finally {
      await rm(controlRoot, { recursive: true, force: true });
    }
  }

  private buildResult(
    input: RepoFinalizeCodexRunInput,
    manifest: DelegationRunManifestV3,
    changedPaths: string[],
    validation: CodexRunFinalizerValidation,
    commitSha: string,
    archive: ArchiveEvidence
  ): DelegationResultV3 {
    const expectedIds = manifest.task.technical_acceptance_criteria.map(({ id }) => id).sort();
    const actualIds = input.technical_acceptance_evidence.map(({ id }) => id).sort();
    if (!sameStrings(expectedIds, actualIds)) {
      throw new RepoReaderError("VALIDATION_ERROR", "technical_acceptance_evidence must cover every manifest TAC exactly once.", {
        diagnostics: { expected_ids: expectedIds, actual_ids: actualIds }
      });
    }
    return DelegationResultV3Schema.parse({
      schema_version: 3,
      repo_id: input.repo_id,
      run_id: input.run_id,
      status: "completed",
      summary: input.summary,
      changed_files: changedPaths,
      connected_changes: changedPaths.map((path) => ({ path, reason: input.change_reason })),
      commands_run: [
        validation.command,
        "git diff --check --",
        `git add -- <${changedPaths.length} exact manifest-authorized paths>`,
        `git commit --no-gpg-sign -m ${JSON.stringify(input.commit_message)}`,
        `git archive --format=tar --prefix=${archive.prefix} -o ${archive.path} ${commitSha}`
      ],
      tests: [
        `Fixed provider-free unittest validation: PASS (${validation.tests_run} tests).`,
        "Git diff whitespace check: PASS.",
        `Exact source hashes, index, commit, and archive read-back: PASS (${archive.byte_length} bytes; ${archive.sha256}).`
      ],
      product_acceptance_criteria: [],
      technical_acceptance_criteria: input.technical_acceptance_evidence.map(({ id, evidence }) => ({
        id,
        status: "passed" as const,
        evidence
      })),
      scope_extension_required: [],
      blockers: [],
      followups: []
    });
  }

  private async commit(input: RepoFinalizeCodexRunInput, changedPaths: string[]): Promise<string> {
    const identity = (await this.gitText(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", input.expected_head_sha])).split("\0");
    if (identity.length !== 4 || identity.some((value) => value.length === 0)) {
      throw new RepoReaderError("GIT_ERROR", "Parent commit identity is unavailable for exact local commit.");
    }
    const commitEnv = {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: identity[0],
      GIT_AUTHOR_EMAIL: identity[1],
      GIT_COMMITTER_NAME: identity[2],
      GIT_COMMITTER_EMAIL: identity[3]
    };
    await this.git(["-c", "core.hooksPath=/dev/null", "add", "--", ...changedPaths], commitEnv);
    const staged = await this.gitZeroList(["diff", "--cached", "--name-only", "-z", "--"]);
    if (!sameStrings(staged, changedPaths)) {
      throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Staged paths do not match the exact finalizer path set.", {
        diagnostics: { expected_paths: changedPaths, actual_paths: staged }
      });
    }
    const commitResult = await this.git([
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false",
      "commit", "--no-gpg-sign", "-m", input.commit_message
    ], commitEnv, [0]);
    if (commitResult.exit_code !== 0) {
      throw new RepoReaderError("GIT_ERROR", "Exact local commit failed.");
    }
    const newHead = await this.gitText(["rev-parse", "HEAD"]);
    const parents = (await this.gitText(["rev-list", "--parents", "-n", "1", newHead])).split(/\s+/);
    if (parents.length !== 2 || parents[1] !== input.expected_head_sha) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Commit parent does not match the bound baseline.");
    }
    if ((await this.gitText(["log", "-1", "--format=%s"])) !== input.commit_message) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Commit message read-back does not match the bound message.");
    }
    const rawCommit = (await this.git(["cat-file", "commit", newHead])).stdout;
    if (`\n${rawCommit}`.includes("\ngpgsig ")) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Commit was unexpectedly signed.");
    }
    const committed = await this.gitZeroList(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", newHead]);
    if (!sameStrings(committed, changedPaths)) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed path set does not match the exact finalizer path set.");
    }
    return newHead;
  }

  private async createArchive(input: RepoFinalizeCodexRunInput, commitSha: string, trackedPaths: string[]): Promise<ArchiveEvidence> {
    const short = commitSha.slice(0, 12);
    const safeRepoId = input.repo_id.replace(/[^A-Za-z0-9._-]/g, "-");
    const destination = join(this.archiveRoot, `${safeRepoId}-${short}-${input.archive_label}.tar`);
    await mkdir(this.archiveRoot, { recursive: true, mode: 0o700 });
    try {
      await lstat(destination);
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Exact archive destination already exists.", {
        diagnostics: { archive_path: destination }
      });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    const prefix = `${safeRepoId}-${short}/`;
    const treeEntries = await this.readRegularTree(commitSha);
    if (!sameStrings(treeEntries, trackedPaths)) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Committed tree does not contain the exact tracked regular-file set.");
    }
    await this.git([
      "archive", "--format=tar", `--prefix=${prefix}`, "-o", destination, commitSha
    ]);
    const archiveStat = await lstat(destination);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size <= 0 || archiveStat.size > MAX_ARCHIVE_BYTES) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed-source archive is missing, unsafe, empty, or oversized.");
    }
    const members = parseTar(await readFile(destination), prefix);
    if (!sameStrings(members, trackedPaths)) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Archive regular-file membership does not match the committed tree.", {
        diagnostics: { expected_count: trackedPaths.length, actual_count: members.length }
      });
    }
    return {
      path: destination,
      byte_length: archiveStat.size,
      sha256: await sha256File(destination),
      prefix,
      regular_file_count: members.length
    };
  }

  private async verifySuccessReadback(
    input: RepoFinalizeCodexRunInput,
    changedPaths: string[],
    commitSha: string,
    archive: ArchiveEvidence,
    resultPath: string
  ): Promise<void> {
    const [branch, head, remotes, tracked, staged, unstaged] = await Promise.all([
      this.gitText(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.gitText(["rev-parse", "HEAD"]),
      this.gitLineList(["remote"]),
      this.gitZeroList(["ls-files", "-z"]),
      this.gitZeroList(["diff", "--cached", "--name-only", "-z", "--"]),
      this.gitZeroList(["diff", "--name-only", "-z", "--"])
    ]);
    if (
      branch !== input.expected_branch
      || head !== commitSha
      || !sameStrings(remotes, input.expected_remote_names)
      || tracked.length !== input.expected_tracked_path_count
      || staged.length > 0
      || unstaged.length > 0
    ) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Post-commit Git read-back does not match the exact finalizer contract.");
    }
    await this.verifyAbsentRefs(input.expected_absent_refs);
    await this.assertNoGitOperation();
    const resultText = await readSafeRunArtifact(this.root, resultPath, MAX_RESULT_BYTES);
    if (!resultText) throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "RESULT.json is missing after commit.");
    const result = parseDelegationResultV3(resultText, input.repo_id, input.run_id);
    if (!sameStrings(result.changed_files, changedPaths)) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "RESULT.json changed_files do not match the exact committed path set.");
    }
    const connected = result.connected_changes.map((entry) => {
      if (!("path" in entry)) {
        throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "RESULT.json connected_changes is not in the exact per-path finalizer form.");
      }
      return { path: entry.path, reason: entry.reason };
    });
    const expectedConnected = changedPaths.map((path) => ({ path, reason: input.change_reason }));
    const actualTechnical = result.technical_acceptance_criteria
      .map(({ id, status: criterionStatus, evidence }) => ({ id, status: criterionStatus, evidence }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const expectedTechnical = input.technical_acceptance_evidence
      .map(({ id, evidence }) => ({ id, status: "passed" as const, evidence }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      result.summary !== input.summary
      || JSON.stringify(connected) !== JSON.stringify(expectedConnected)
      || JSON.stringify(actualTechnical) !== JSON.stringify(expectedTechnical)
      || result.blockers.length > 0
      || result.followups.length > 0
      || result.scope_extension_required.length > 0
    ) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "RESULT.json semantics do not match the durable exact finalizer request.");
    }
    const parents = (await this.gitText(["rev-list", "--parents", "-n", "1", commitSha])).split(/\s+/);
    if (parents.length !== 2 || parents[1] !== input.expected_head_sha) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed parent no longer matches the bound baseline.");
    }
    if ((await this.gitText(["log", "-1", "--format=%s"])) !== input.commit_message) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed message no longer matches the durable finalizer request.");
    }
    const rawCommit = (await this.git(["cat-file", "commit", commitSha])).stdout;
    if (`\n${rawCommit}`.includes("\ngpgsig ")) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed result is unexpectedly signed.");
    }
    const committedPaths = await this.gitZeroList(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitSha]);
    if (!sameStrings(committedPaths, changedPaths)) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed path set no longer matches the durable exact finalizer request.");
    }
    const status = await this.runStore.readStatus(input.run_id);
    if (!status || status.status !== "committed" || status.head_after !== commitSha || !status.result_found) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Terminal runner status is not committed after read-back.");
    }
    let archiveStat;
    try {
      archiveStat = await stat(archive.path);
    } catch {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed-source archive is missing or unreadable during replay read-back.");
    }
    if (archiveStat.size !== archive.byte_length || await sha256File(archive.path) !== archive.sha256) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Archive digest or byte length changed after creation.");
    }
    for (const sidecar of [`${archive.path}.sha256`, archive.path.replace(/\.tar$/, ".sha256"), `${archive.path}.json`]) {
      try {
        await access(sidecar);
        throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Unexpected archive sidecar exists.", { diagnostics: { path: sidecar } });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }

  private async verifyPostValidationGit(input: RepoFinalizeCodexRunInput, changedPaths: string[]): Promise<void> {
    const [head, staged, changed] = await Promise.all([
      this.gitText(["rev-parse", "HEAD"]),
      this.gitZeroList(["diff", "--cached", "--name-only", "-z", "--"]),
      this.gitZeroList(["diff", "--name-only", "-z", "--"])
    ]);
    if (head !== input.expected_head_sha || staged.length > 0 || !sameStrings(changed, changedPaths)) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Validation changed the bound Git source state.");
    }
    await this.assertStatusSurface(changedPaths);
  }

  private async assertSafeChangedFile(path: string, expectedSha256: string, headSha: string): Promise<void> {
    if (isHardSecretPath(path) && !isAllowedEnvTemplatePath(path)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Secret candidate path cannot be finalized: ${path}`);
    }
    const absolute = join(this.root, path);
    const fileStat = await lstat(absolute);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Exact-run finalizer supports regular tracked files only: ${path}`);
    }
    await assertRealPathWithinRoot(this.root, absolute);
    const currentBytes = await readFile(absolute);
    if (sha256(currentBytes) !== expectedSha256) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", `Changed-file SHA-256 does not match the exact binding: ${path}`);
    }
    let current: string;
    try {
      current = new TextDecoder("utf-8", { fatal: true }).decode(currentBytes);
    } catch {
      throw new RepoReaderError("BINARY_FILE_REJECTED", `Exact-run finalizer requires strict UTF-8 source text: ${path}`);
    }
    const prior = (await this.git(["show", `${headSha}:${path}`])).stdout;
    if (this.secretScanner.hasNewSecretValue(prior, current)) {
      throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `New secret-like content cannot be finalized: ${path}`);
    }
  }

  private async verifySourceHashes(input: RepoFinalizeCodexRunInput, changedPaths: string[]): Promise<void> {
    const expected = new Map(input.expected_changed_files.map((entry) => [entry.path, entry.sha256]));
    for (const path of changedPaths) {
      const digest = await sha256File(join(this.root, path));
      if (digest !== expected.get(path)) {
        throw new RepoReaderError("TASK_STATE_MISMATCH", `Source hash changed during finalization: ${path}`);
      }
    }
  }

  private async assertStatusSurface(expectedChangedPaths: string[]): Promise<void> {
    const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const records = status.stdout.split("\0").filter(Boolean);
    const tracked = new Set<string>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) throw new RepoReaderError("TASK_STATE_MISMATCH", "Git status record is malformed.");
      const state = record.slice(0, 2);
      const path = record.slice(3);
      if (/[\0\r\n]/.test(path)) throw new RepoReaderError("TASK_STATE_MISMATCH", "Git status path contains control characters.");
      if (state.includes("R") || state.includes("C")) {
        throw new RepoReaderError("TASK_STATE_MISMATCH", "Exact-run finalizer refuses rename or copy status.");
      }
      if (state === "??") {
        if (!path.startsWith(".chatgpt/")) {
          throw new RepoReaderError("TASK_STATE_MISMATCH", `Unexpected untracked path outside run control: ${path}`);
        }
        continue;
      }
      if (state[0] !== " ") {
        throw new RepoReaderError("GIT_STAGED_PATHS_MISMATCH", "Index must remain clean before commit.");
      }
      tracked.add(path);
    }
    if (!sameStrings([...tracked], expectedChangedPaths)) {
      throw new RepoReaderError("TASK_STATE_MISMATCH", "Git status tracked path set does not match the exact finalizer binding.");
    }
  }

  private async assertNoGitOperation(): Promise<void> {
    const gitDirText = await this.gitText(["rev-parse", "--absolute-git-dir"]);
    const gitDir = resolve(gitDirText);
    await assertRealPathWithinRoot(this.root, gitDir);
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-apply",
      "rebase-merge",
      "sequencer"
    ]) {
      try {
        await lstat(join(gitDir, marker));
        throw new RepoReaderError("TASK_STATE_MISMATCH", `Git operation is in progress: ${marker}`);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
  }

  private async verifyAbsentRefs(refs: string[]): Promise<void> {
    for (const ref of refs) {
      const result = await this.git(["show-ref", "--verify", "--quiet", ref], undefined, [0, 1]);
      if (result.exit_code === 0) {
        throw new RepoReaderError("TASK_STATE_MISMATCH", `Expected absent ref exists: ${ref}`);
      }
    }
  }

  private async readRegularTree(commitSha: string): Promise<string[]> {
    const output = await this.git(["ls-tree", "-rz", "--full-tree", commitSha]);
    const paths: string[] = [];
    for (const record of output.stdout.split("\0").filter(Boolean)) {
      const match = record.match(/^(\d{6})\s+(\w+)\s+[a-f0-9]{40}\t(.+)$/s);
      if (!match) throw new RepoReaderError("GIT_ERROR", "git ls-tree returned an unexpected record.");
      const [, mode, type, path] = match;
      if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
        throw new RepoReaderError("TASK_OPERATION_BLOCKED", `Archive source contains a non-regular tracked entry: ${path}`);
      }
      paths.push(path);
    }
    return paths.sort((a, b) => a.localeCompare(b));
  }

  private async resolvePython(): Promise<string> {
    for (const candidate of this.pythonCandidates) {
      if (!candidate.includes(sep)) continue;
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new RepoReaderError("VALIDATION_NODE_RUNTIME_UNAVAILABLE", "No fixed absolute Python 3 executable is available for unittest validation.");
  }

  private async restoreIndex(paths: string[]): Promise<void> {
    const staged = await this.gitZeroList(["diff", "--cached", "--name-only", "-z", "--"]);
    if (staged.length === 0) return;
    if (!sameStrings(staged, paths)) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Cannot safely restore an unexpected staged path set.");
    }
    await this.git(["restore", "--staged", "--", ...staged]);
  }

  private async writeFailureStatus(
    input: RepoFinalizeCodexRunInput,
    prior: AgentRunnerStatus,
    validationPath: string,
    currentHead: string,
    reason: string
  ): Promise<void> {
    const now = this.now().toISOString();
    const resultPath = codexRunPaths(input.run_id).resultJsonPath;
    const resultFound = await fileExists(join(this.root, resultPath));
    await this.runStore.writeStatus({
      manifest_version: 3,
      review_requirement: "technical_only",
      repo_id: input.repo_id,
      run_id: input.run_id,
      runner: prior.runner,
      status: "blocked_verification",
      revision: prior.revision + 1,
      started_at: prior.started_at,
      completed_at: now,
      prompt_path: codexRunPaths(input.run_id).promptPath,
      result_json_path: resultPath,
      result_found: resultFound,
      head_before: input.expected_head_sha,
      head_after: currentHead,
      worktree_fingerprint_before: prior.worktree_fingerprint_before,
      worktree_fingerprint_after: null,
      changed_paths: input.expected_changed_files.map(({ path }) => path).sort(),
      validation: {
        status: "failed",
        profile: "test",
        artifact_path: await fileExists(join(this.root, validationPath)) ? validationPath : null
      },
      commit: {
        attempted: true,
        allowed: true,
        status: "committed",
        commit_sha: currentHead
      },
      warnings: uniqueStrings([
        ...prior.warnings.filter((warning) => !warning.startsWith("STOP_REASON=")),
        `EXACT_RUN_FINALIZER_STOP_REASON=${markerValue(reason)}`,
        "EXACT_RUN_FINALIZER_PARTIAL_AFTER_COMMIT"
      ])
    });
  }

  private async readExistingSuccess(
    input: RepoFinalizeCodexRunInput,
    statePath: string,
    validationPath: string
  ): Promise<RepoFinalizeCodexRunResult | undefined> {
    const stateText = await readSafeRunArtifact(this.root, statePath, MAX_STATE_BYTES);
    if (!stateText) return undefined;
    let state: FinalizerState;
    try {
      state = JSON.parse(stateText) as FinalizerState;
    } catch {
      throw new RepoReaderError("AGENT_RUN_ARTIFACT_INVALID", "Finalizer state is malformed.");
    }
    const requestSha256 = canonicalInputSha256(input);
    if (state.request_sha256 !== requestSha256) {
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Exact-run finalizer request does not match the durable operation binding.", {
        diagnostics: { status: state.status }
      });
    }
    if (state.operation_id !== input.operation_id) {
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Another exact-run finalizer operation already owns this run.", {
        diagnostics: { existing_operation_id: state.operation_id, requested_operation_id: input.operation_id, status: state.status }
      });
    }
    if (state.status !== "committed" || !state.head_after || !state.archive) {
      if (state.status === "failed_before_commit") return undefined;
      throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Exact-run finalizer state is already in progress or requires read-back before any retry.", {
        diagnostics: { status: state.status, head_after: state.head_after }
      });
    }
    const status = await this.runStore.readStatus(input.run_id);
    const validationText = await readSafeRunArtifact(this.root, validationPath, MAX_STATUS_BYTES);
    if (!status || status.status !== "committed" || status.head_after !== state.head_after || !validationText) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Committed finalizer state cannot be reconstructed from terminal artifacts.");
    }
    await this.verifySuccessReadback(
      input,
      status.changed_paths,
      state.head_after,
      state.archive,
      codexRunPaths(input.run_id).resultJsonPath
    );
    const validation = JSON.parse(validationText) as CodexRunFinalizerValidation;
    return {
      ok: true,
      dry_run: false,
      operation_id: input.operation_id,
      repo_id: input.repo_id,
      run_id: input.run_id,
      status: "committed",
      head_before: input.expected_head_sha,
      head_after: state.head_after,
      commit_sha: state.head_after,
      changed_paths: status.changed_paths,
      validation: publicValidation(validation, validationPath),
      archive: state.archive,
      result_json_path: codexRunPaths(input.run_id).resultJsonPath,
      runner_status_path: `${codexRunPaths(input.run_id).runDir}/runner.status.json`,
      warnings: status.warnings
    };
  }

  private async acquireState(path: string, state: FinalizerState): Promise<void> {
    const absolute = join(this.root, path);
    try {
      await writeExclusiveJson(absolute, state);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existingText = await readSafeRunArtifact(this.root, path, MAX_STATE_BYTES);
      if (!existingText) throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Finalizer state appeared but could not be read safely.");
      const existing = JSON.parse(existingText) as FinalizerState;
      if (
        existing.operation_id !== state.operation_id
        || existing.request_sha256 !== state.request_sha256
        || existing.status !== "failed_before_commit"
      ) {
        throw new RepoReaderError("TASK_OPERATION_CONFLICT", "Finalizer state already exists for another or active operation.", {
          diagnostics: { existing_operation_id: existing.operation_id, status: existing.status }
        });
      }
      await this.writeState(path, state);
    }
  }

  private async writeState(path: string, state: FinalizerState): Promise<void> {
    await atomicWriteJson(join(this.root, path), state);
  }

  private async git(args: string[], env: NodeJS.ProcessEnv = gitEnvironment(), allowedExitCodes: number[] = [0]): Promise<GitResult> {
    const result = await runProcessWithTail({
      executable: GIT_EXECUTABLE,
      args,
      cwd: this.root,
      env,
      timeout_ms: 120_000,
      tail_bytes: 256 * 1024,
      capture_bytes: MAX_GIT_CAPTURE_BYTES
    });
    const captured = result.captured_output ?? { stdout: result.stdout_tail, stderr: result.stderr_tail, truncated: false };
    const exitCode = result.exit_code ?? -1;
    if (result.timed_out || captured.truncated || !allowedExitCodes.includes(exitCode)) {
      throw new RepoReaderError("GIT_ERROR", "Fixed Git operation failed, timed out, or exceeded its capture bound.", {
        diagnostics: {
          args: args.slice(0, 12),
          exit_code: result.exit_code,
          timed_out: result.timed_out,
          stderr: redactSensitiveText(result.stderr_tail)
        }
      });
    }
    return { stdout: captured.stdout, stderr: captured.stderr, exit_code: exitCode };
  }

  private async gitText(args: string[]): Promise<string> {
    return (await this.git(args)).stdout.replace(/\n$/, "");
  }

  private async gitZeroList(args: string[]): Promise<string[]> {
    return (await this.git(args)).stdout.split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  private async gitLineList(args: string[]): Promise<string[]> {
    return (await this.git(args)).stdout.split(/\r?\n/).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }
}

function canonicalInputSha256(input: RepoFinalizeCodexRunInput): string {
  return sha256(Buffer.from(JSON.stringify(canonicalize(input)), "utf8"));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function publicValidation(validation: CodexRunFinalizerValidation, artifactPath: string | null) {
  return {
    profile: validation.profile,
    command: validation.command,
    tests_run: validation.tests_run,
    duration_ms: validation.duration_ms,
    output_sha256: validation.output_sha256,
    artifact_path: artifactPath
  } as const;
}

function terminalWarnings(
  input: RepoFinalizeCodexRunInput,
  prior: AgentRunnerStatus,
  validation: CodexRunFinalizerValidation,
  archive: ArchiveEvidence
): string[] {
  return uniqueStrings([
    ...prior.warnings.filter((warning) => !warning.startsWith("STOP_REASON=")),
    `PRIOR_TERMINAL_STATUS=${prior.status.toUpperCase()}`,
    `PRIOR_TERMINAL_REVISION=${prior.revision}`,
    "EXACT_RUN_FINALIZER=PASS",
    "FINAL_PROVIDER_CONTACT=0",
    "FINAL_MODEL_TURNS=0",
    `FINAL_VALIDATION_TESTS=${validation.tests_run}`,
    `ARCHIVE_PATH=${archive.path}`,
    `ARCHIVE_BYTES=${archive.byte_length}`,
    `ARCHIVE_SHA256=${archive.sha256}`,
    `ARCHIVE_PREFIX=${archive.prefix}`,
    ...input.terminal_markers
  ]);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: FIXED_PROCESS_PATH,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C"
  };
}

function parseTar(data: Buffer, expectedPrefix: string): string[] {
  const regular: string[] = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    if (fullName.startsWith("/") || fullName.includes("\0") || fullName.split("/").some((part) => part === ".." || part === ".git")) {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", `Archive contains an unsafe path: ${fullName}`);
    }
    if (!fullName.startsWith(expectedPrefix) && typeFlag !== "g" && typeFlag !== "x") {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", `Archive member is outside the exact prefix: ${fullName}`);
    }
    if (typeFlag === "0") {
      const relativePath = fullName.slice(expectedPrefix.length);
      if (!relativePath || relativePath.endsWith("/")) {
        throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Archive contains an invalid regular-file path.");
      }
      regular.push(relativePath);
    } else if (typeFlag !== "5" && typeFlag !== "g" && typeFlag !== "x") {
      throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", `Archive contains a non-regular member type: ${typeFlag}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return regular.sort((a, b) => a.localeCompare(b));
}

function tarString(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

function tarOctal(value: Buffer): number {
  const text = tarString(value).trim().replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(text)) throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Archive size field is invalid.");
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new RepoReaderError("EXTERNAL_EFFECT_UNKNOWN", "Archive size exceeds safe bounds.");
  return parsed;
}

async function findPythonArtifacts(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    const dir = await import("node:fs/promises").then(({ readdir }) => readdir(directory, { withFileTypes: true }));
    for (const entry of dir) {
      entries += 1;
      if (entries > MAX_WALK_ENTRIES) throw new RepoReaderError("SIZE_LIMIT_EXCEEDED", "Repository walk exceeded the bytecode-audit entry bound.");
      if (entry.name === ".git" || entry.name === ".chatgpt" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") found.push(relative(root, absolute));
        else await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".pyc")) {
        found.push(relative(root, absolute));
      }
    }
  };
  await visit(root);
  return found.sort();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return redactSensitiveText(message).replace(/[\0\r\n]+/g, " ").slice(0, 1_000);
}

function markerValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_./:@+,-]/g, "_").slice(0, 400) || "UNKNOWN";
}
