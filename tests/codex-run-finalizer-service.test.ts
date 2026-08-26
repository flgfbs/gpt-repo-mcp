import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RepoFinalizeCodexRunInput } from "../src/contracts/codex-run-finalizer.contract.js";
import { DelegationRunStore } from "../src/delegation/run-store.js";
import { RepoReaderError } from "../src/runtime/errors.js";
import {
  CodexRunFinalizerService,
  type CodexRunFinalizerValidation
} from "../src/services/codex-run-finalizer-service.js";
import { CodexResultService } from "../src/services/codex-result-service.js";
import { CodexReviewAttestationService } from "../src/services/codex-review-attestation-service.js";
import { DelegationGateService } from "../src/services/delegation-gate-service.js";
import { GitReviewService } from "../src/services/git-review-service.js";
import { PathSandbox } from "../src/services/path-sandbox.js";
import { WritePolicy } from "../src/services/write-policy.js";
import { codexRunPaths } from "../src/services/codex-run-paths.js";
import { writeQueuedV3Run } from "./fixtures/delegation-v3-run-fixture.js";

const execFileAsync = promisify(execFile);
const RUN_ID = "2026-08-26T010000Z-exact-run-finalizer";
const NOW = new Date("2026-08-26T01:30:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CodexRunFinalizerService", () => {
  test("dry-runs and then atomically commits, archives, closes, and replays one exact run", async () => {
    const fixture = await createFinalizerFixture();
    const validate = vi.fn(async () => passingValidation());
    const service = new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate
    });

    const preview = await service.finalize({ ...fixture.input, dry_run: true });
    expect(preview).toMatchObject({
      dry_run: true,
      status: "validated",
      head_before: fixture.head,
      changed_paths: ["src/value.py"],
      archive: null
    });
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
    await expect(readFile(join(fixture.root, codexRunPaths(RUN_ID).resultJsonPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.root, codexRunPaths(RUN_ID).runDir, "finalizer-state.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const result = await service.finalize(fixture.input);
    expect(result).toMatchObject({
      dry_run: false,
      status: "committed",
      head_before: fixture.head,
      changed_paths: ["src/value.py"]
    });
    expect(result.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.head_after).toBe(result.commit_sha);
    expect(result.archive).toMatchObject({
      regular_file_count: fixture.trackedPathCount
    });
    expect(result.archive?.path.startsWith(`${fixture.archiveRoot}/`)).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);

    const commitSha = result.commit_sha!;
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(commitSha);
    expect(await git(fixture.root, "rev-parse", `${commitSha}^`)).toBe(fixture.head);
    expect(await git(fixture.root, "log", "-1", "--format=%s")).toBe(fixture.input.commit_message);
    expect(await git(fixture.root, "diff", "--name-only")).toBe("");
    expect(await git(fixture.root, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(fixture.root, "diff-tree", "--no-commit-id", "--name-only", "-r", commitSha)).toBe("src/value.py");

    const storedResult = JSON.parse(await readFile(join(fixture.root, codexRunPaths(RUN_ID).resultJsonPath), "utf8")) as Record<string, unknown>;
    expect(storedResult).toMatchObject({
      schema_version: 3,
      repo_id: "fixture",
      run_id: RUN_ID,
      status: "completed",
      changed_files: ["src/value.py"],
      blockers: [],
      followups: []
    });
    const status = await new DelegationRunStore(fixture.root).readStatus(RUN_ID);
    expect(status).toMatchObject({
      status: "committed",
      revision: fixture.input.expected_prior_status_revision + 1,
      result_found: true,
      head_before: fixture.head,
      head_after: commitSha,
      changed_paths: ["src/value.py"],
      validation: { status: "passed", profile: "test" },
      commit: { attempted: true, allowed: true, status: "committed", commit_sha: commitSha }
    });

    const review = await reviewFinalizedRun(fixture.root);
    expect(review.integrity).toMatchObject({
      head_matches_baseline: false,
      head_matches_finalizer_commit: true,
      finalizer_evidence_matches: true
    });
    expect(review.scope_evidence).toMatchObject({
      newly_observed_paths: ["src/value.py"],
      attributed_paths: ["src/value.py"],
      claimed_but_not_observed: [],
      observed_but_unreported: [],
      attribution_ambiguous_paths: []
    });
    expect(review.technical_readiness).toMatchObject({
      status: "passed",
      checks: {
        baseline: "passed",
        change_attribution: "passed",
        validation: "passed"
      }
    });
    expect(review.git_review?.ship_readiness.validation).toMatchObject({
      status: "passed",
      profile: "test",
      head_sha: commitSha,
      artifact_path: `${codexRunPaths(RUN_ID).runDir}/finalizer-validation.json`
    });
    expect(review.warnings).toContain("CODEX_FINALIZER_EVIDENCE_VERIFIED");
    expect(review.warnings).not.toContain("CODEX_BASELINE_HEAD_MISMATCH");
    expect(review.warnings).not.toContain("CODEX_RESULT_CLAIM_MISMATCH");
    expect(review.warnings).not.toContain("VALIDATION_MISSING");
    expect(review.warnings).not.toContain("UNTRACKED_PATHS_REVIEWED_FOR_STAGING");
    expect(review.git_review).toMatchObject({
      clean: true,
      changed_paths: [],
      recommendation: { risk_level: "low", warnings: ["NO_CHANGES"] }
    });
    await attestFinalizedRun(fixture.root, review);
    const passedGate = await finalizerGateDecision(fixture.root, commitSha);
    expect(passedGate).toMatchObject({
      status: "passed",
      applicable_runs: [expect.objectContaining({
        run_id: RUN_ID,
        status: "passed",
        review_status: "valid",
        product_verdict: "not_applicable"
      })]
    });

    const replayValidation = vi.fn(async () => {
      throw new Error("replay must not rerun validation");
    });
    const replay = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: replayValidation
    }).finalize(fixture.input);
    expect(replay.commit_sha).toBe(commitSha);
    expect(replay.archive?.sha256).toBe(result.archive?.sha256);
    expect(replayValidation).not.toHaveBeenCalled();

    await expect(new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: replayValidation
    }).finalize({ ...fixture.input, summary: "A different request must not share the same operation id." })).rejects.toMatchObject({
      code: "TASK_OPERATION_CONFLICT"
    } satisfies Partial<RepoReaderError>);

    await rm(result.archive!.path);
    await expect(new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: replayValidation
    }).finalize(fixture.input)).rejects.toMatchObject({
      code: "EXTERNAL_EFFECT_UNKNOWN"
    } satisfies Partial<RepoReaderError>);
    const missingArchiveReview = await reviewFinalizedRun(fixture.root);
    expect(missingArchiveReview.integrity).toMatchObject({
      head_matches_baseline: false,
      head_matches_finalizer_commit: false,
      finalizer_evidence_matches: false
    });
    expect(missingArchiveReview.technical_readiness.status).toBe("failed");
    expect(missingArchiveReview.warnings).toEqual(expect.arrayContaining([
      "CODEX_FINALIZER_ARCHIVE_MISMATCH",
      "CODEX_FINALIZER_EVIDENCE_INVALID",
      "CODEX_BASELINE_HEAD_MISMATCH"
    ]));
    const staleGate = await finalizerGateDecision(fixture.root, commitSha);
    expect(staleGate).toMatchObject({
      status: "advisory",
      applicable_runs: [expect.objectContaining({
        run_id: RUN_ID,
        status: "stale",
        review_status: "stale",
        reasons: ["DELEGATION_REVIEW_STATE_CHANGED"]
      })]
    });
  }, 30_000);

  test("fails closed when a committed archive path is replaced by a symlink", async () => {
    const fixture = await createFinalizerFixture();
    const result = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    }).finalize(fixture.input);
    const relocated = `${result.archive!.path}.relocated`;
    await rename(result.archive!.path, relocated);
    await symlink(relocated, result.archive!.path);

    const review = await reviewFinalizedRun(fixture.root);
    expect(review.integrity).toMatchObject({
      head_matches_baseline: false,
      head_matches_finalizer_commit: false,
      finalizer_evidence_matches: false
    });
    expect(review.technical_readiness.status).toBe("failed");
    expect(review.warnings).toEqual(expect.arrayContaining([
      "CODEX_FINALIZER_ARCHIVE_MISMATCH",
      "CODEX_FINALIZER_EVIDENCE_INVALID"
    ]));
  });

  test("fails closed when durable finalizer state is forged after a valid commit", async () => {
    const fixture = await createFinalizerFixture();
    const result = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    }).finalize(fixture.input);
    const statePath = join(fixture.root, codexRunPaths(RUN_ID).runDir, "finalizer-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { head_after: string };
    state.head_after = fixture.head;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const review = await reviewFinalizedRun(fixture.root);
    expect(result.commit_sha).not.toBe(fixture.head);
    expect(review.integrity).toMatchObject({
      head_matches_baseline: false,
      head_matches_finalizer_commit: false,
      finalizer_evidence_matches: false
    });
    expect(review.technical_readiness.status).toBe("failed");
    expect(review.warnings).toEqual(expect.arrayContaining([
      "CODEX_FINALIZER_STATE_INVALID",
      "CODEX_FINALIZER_EVIDENCE_INVALID",
      "CODEX_BASELINE_HEAD_MISMATCH"
    ]));
  });

  test("does not execute repository fsmonitor or clean filters and preserves literal export-subst bytes", async () => {
    const fixture = await createFinalizerFixture();
    const sentinel = join(fixture.root, ".git", "repository-helper-executed");
    const helper = join(fixture.root, ".git", "repository-helper.sh");
    await writeFile(
      helper,
      `#!/bin/sh\n/usr/bin/touch ${shellQuote(sentinel)}\n/bin/cat\n`,
      "utf8"
    );
    await chmod(helper, 0o700);
    const referenceHook = join(fixture.root, ".git", "hooks", "reference-transaction");
    await writeFile(referenceHook, await readFile(helper));
    await chmod(referenceHook, 0o700);
    await git(fixture.root, "config", "core.fsmonitor", helper);
    await git(fixture.root, "config", "filter.trap.clean", helper);
    await git(fixture.root, "config", "filter.trap.required", "true");

    const literalSource = "VALUE = \"$Format:%H$\"\n";
    await writeFile(join(fixture.root, "src", "value.py"), literalSource, "utf8");
    const exactInput: RepoFinalizeCodexRunInput = {
      ...fixture.input,
      expected_changed_files: [{
        path: "src/value.py",
        sha256: createHash("sha256").update(literalSource).digest("hex")
      }]
    };
    const result = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    }).finalize(exactInput);

    const review = await reviewFinalizedRun(fixture.root);
    expect(review.integrity).toMatchObject({
      head_matches_finalizer_commit: true,
      finalizer_evidence_matches: true
    });
    expect(review.technical_readiness.status).toBe("passed");
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(fixture.root, "show", `${result.commit_sha}:src/value.py`)).toBe(literalSource.trimEnd());
    const archived = readTarEntry(
      await readFile(result.archive!.path),
      `${result.archive!.prefix}src/value.py`
    );
    expect(archived.toString("utf8")).toBe(literalSource);
  });

  test("ignores replacement objects when binding and creating the exact commit", async () => {
    const fixture = await createFinalizerFixture();
    const replacement = await git(fixture.root, "commit-tree", fixture.tree, "-m", "replacement commit");
    await git(fixture.root, "replace", fixture.head, replacement);

    const result = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    }).finalize(fixture.input);

    expect(await git(fixture.root, "--no-replace-objects", "rev-parse", `${result.commit_sha}^`)).toBe(fixture.head);
    expect(await git(fixture.root, "--no-replace-objects", "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_sha!)).toBe("src/value.py");
    const review = await reviewFinalizedRun(fixture.root);
    expect(review.integrity).toMatchObject({
      head_matches_finalizer_commit: true,
      finalizer_evidence_matches: true
    });
    expect(review.technical_readiness.status).toBe("passed");
  });

  test("runs the fixed provider-free unittest validation path without an injected validator", async () => {
    const fixture = await createFinalizerFixture();
    const result = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW
    }).finalize({ ...fixture.input, dry_run: true });

    expect(result).toMatchObject({
      dry_run: true,
      status: "validated",
      head_before: fixture.head,
      changed_paths: ["src/value.py"],
      validation: {
        profile: "test",
        tests_run: 1,
        artifact_path: null
      },
      archive: null
    });
    expect(result.validation.command).toContain(" -B -m unittest discover -v");
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(await git(fixture.root, "diff", "--name-only")).toBe("src/value.py");
  });

  test("rejects a concurrent replay while the exact operation is active", async () => {
    const fixture = await createFinalizerFixture();
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      validationStarted = resolveStarted;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseValidation = resolveRelease;
    });
    const first = new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => {
        validationStarted();
        await release;
        throw new RepoReaderError("VALIDATION_ERROR", "synthetic active-operation stop");
      }
    });
    const firstAttempt = first.finalize(fixture.input);
    await started;

    await expect(new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    }).finalize(fixture.input)).rejects.toMatchObject({
      code: "TASK_OPERATION_CONFLICT"
    } satisfies Partial<RepoReaderError>);

    releaseValidation();
    await expect(firstAttempt).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    } satisfies Partial<RepoReaderError>);
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
  });

  test("fails before mutation when an exact changed-file digest drifts", async () => {
    const fixture = await createFinalizerFixture();
    const service = new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => passingValidation()
    });
    const input: RepoFinalizeCodexRunInput = {
      ...fixture.input,
      expected_changed_files: [{ path: "src/value.py", sha256: "0".repeat(64) }]
    };

    await expect(service.finalize(input)).rejects.toMatchObject({
      code: "TASK_STATE_MISMATCH"
    } satisfies Partial<RepoReaderError>);
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(await git(fixture.root, "diff", "--name-only")).toBe("src/value.py");
    await expect(readFile(join(fixture.root, codexRunPaths(RUN_ID).runDir, "finalizer-state.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves prior runner status and safely retries the same operation after pre-commit validation failure", async () => {
    const fixture = await createFinalizerFixture();
    const first = new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => NOW,
      validate: async () => {
        throw new RepoReaderError("VALIDATION_ERROR", "synthetic pre-commit failure");
      }
    });

    await expect(first.finalize(fixture.input)).rejects.toMatchObject({
      code: "VALIDATION_ERROR"
    } satisfies Partial<RepoReaderError>);
    const prior = await new DelegationRunStore(fixture.root).readStatus(RUN_ID);
    expect(prior).toMatchObject({
      status: fixture.input.expected_prior_status,
      revision: fixture.input.expected_prior_status_revision,
      result_found: false,
      commit: { attempted: false, status: "skipped" }
    });
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(await git(fixture.root, "diff", "--cached", "--name-only")).toBe("");

    const retry = await new CodexRunFinalizerService(fixture.root, {
      archive_root: fixture.archiveRoot,
      now: () => new Date(NOW.getTime() + 1_000),
      validate: async () => passingValidation()
    }).finalize(fixture.input);
    expect(retry.status).toBe("committed");
    expect(retry.commit_sha).toMatch(/^[a-f0-9]{40}$/);
  });
});

async function createFinalizerFixture(): Promise<{
  root: string;
  archiveRoot: string;
  head: string;
  tree: string;
  trackedPathCount: number;
  input: RepoFinalizeCodexRunInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "exact-run-finalizer-repo-"));
  const archiveRoot = await mkdtemp(join(tmpdir(), "exact-run-finalizer-archive-"));
  roots.push(root, archiveRoot);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await writeFile(join(root, ".gitattributes"), "src/value.py filter=trap export-subst\n", "utf8");
  await writeFile(join(root, "pyproject.toml"), "[tool.unittest]\nstart-directory = \"tests\"\n", "utf8");
  await writeFile(join(root, "src", "value.py"), "VALUE = 1\n", "utf8");
  await writeFile(join(root, "tests", "__init__.py"), "", "utf8");
  await writeFile(join(root, "tests", "test_value.py"), "import unittest\n\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(1, 1)\n", "utf8");

  await git(root, "init", "--initial-branch=work");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "add", ".gitattributes", "README.md", "pyproject.toml", "src/value.py", "tests/__init__.py", "tests/test_value.py");
  await git(root, "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "fixture baseline");
  const head = await git(root, "rev-parse", "HEAD");
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  const trackedPathCount = (await gitBuffer(root, "ls-files", "-z")).toString("utf8").split("\0").filter(Boolean).length;

  const manifest = await writeQueuedV3Run(root, RUN_ID, {
    runner: "codex_sdk",
    task_kind: "technical_infrastructure",
    authorization_scope: ["README.md", "pyproject.toml", "src/**", "tests/**"],
    validation: { profile: "test", test_paths: [] },
    baseline: {
      head_sha: head,
      worktree_fingerprint: "clean",
      initial_changed_paths: [],
      initial_path_states: []
    },
    created_at: "2026-08-26T01:00:00.000Z"
  });
  const paths = codexRunPaths(RUN_ID);
  const revision = 7;
  await new DelegationRunStore(root, { now: () => NOW }).writeStatus({
    manifest_version: 3,
    review_requirement: "technical_only",
    repo_id: "fixture",
    run_id: RUN_ID,
    runner: "codex_sdk",
    status: "failed",
    revision,
    started_at: "2026-08-26T01:01:00.000Z",
    completed_at: "2026-08-26T01:10:00.000Z",
    prompt_path: paths.promptPath,
    result_json_path: paths.resultJsonPath,
    result_found: false,
    head_before: head,
    head_after: null,
    worktree_fingerprint_before: "clean",
    worktree_fingerprint_after: null,
    changed_paths: [],
    validation: { status: "failed", profile: "test", artifact_path: null },
    commit: { attempted: false, allowed: false, status: "skipped", commit_sha: null },
    warnings: ["STOP_REASON=SYNTHETIC_VALIDATION_FAILURE"]
  });

  await writeFile(join(root, "src", "value.py"), "VALUE = 2\n", "utf8");
  const sourceSha256 = createHash("sha256").update(await readFile(join(root, "src", "value.py"))).digest("hex");
  const technicalAcceptanceEvidence = manifest.task.technical_acceptance_criteria.map(({ id }) => ({
    id,
    evidence: "The exact fixed validation and local Git read-back passed."
  }));
  const input: RepoFinalizeCodexRunInput = {
    operation_id: "exact-run-finalizer-test-0001",
    repo_id: "fixture",
    run_id: RUN_ID,
    expected_prior_status: "failed",
    expected_prior_status_revision: revision,
    expected_branch: "work",
    expected_head_sha: head,
    expected_tree_sha: tree,
    expected_changed_files: [{ path: "src/value.py", sha256: sourceSha256 }],
    expected_tracked_path_count: trackedPathCount,
    expected_remote_names: [],
    expected_absent_refs: ["refs/heads/main"],
    commit_message: "fix: finalize exact delegated change",
    archive_label: "parent-rereview",
    summary: "Validated and finalized the exact technical Delegation v3 change.",
    change_reason: "This exact source change closes the bound technical task.",
    technical_acceptance_evidence: technicalAcceptanceEvidence,
    terminal_markers: ["NEXT_GATE=PARENT_FOCUSED_REREVIEW"],
    dry_run: false
  };
  return { root, archiveRoot, head, tree, trackedPathCount, input };
}

async function reviewFinalizedRun(root: string) {
  return new CodexResultService(
    new PathSandbox(root),
    new GitReviewService(root),
    root
  ).review({ repo_id: "fixture", run_id: RUN_ID });
}

async function attestFinalizedRun(
  root: string,
  review: Awaited<ReturnType<typeof reviewFinalizedRun>>
) {
  if (review.review_state.status !== "available") {
    throw new Error("Expected available post-finalizer review state.");
  }
  return new CodexReviewAttestationService(
    root,
    new PathSandbox(root),
    new GitReviewService(root),
    new WritePolicy({ enabled: true, allowed_globs: [".chatgpt/codex-runs/**"] }),
    () => NOW
  ).write({
    repo_id: "fixture",
    run_id: RUN_ID,
    expected_review_state_sha256: review.review_state.state_sha256,
    product_verdict: "not_applicable",
    rationale: "The exact finalized technical run is ready for state-bound review.",
    evidence: []
  });
}

async function finalizerGateDecision(root: string, headSha: string) {
  return new DelegationGateService(root).evaluate({
    repo_id: "fixture",
    paths: ["src/value.py"],
    operation: "ship",
    head_sha: headSha
  });
}

function passingValidation(): CodexRunFinalizerValidation {
  return {
    profile: "test",
    command: "python3 -B -m unittest discover -v",
    tests_run: 1,
    duration_ms: 5,
    output_sha256: "a".repeat(64),
    stdout_tail: "Ran 1 test in 0.001s\n\nOK\n",
    stderr_tail: ""
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readTarEntry(data: Buffer, expectedName: string): Buffer {
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarText(header.subarray(124, 136)).trim().replace(/^0+/, "") || "0";
    const size = Number.parseInt(sizeText, 8);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (fullName === expectedName) return Buffer.from(data.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Tar entry not found: ${expectedName}`);
}

function tarText(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end < 0 ? value.length : end).toString("utf8");
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout.replace(/\n$/, "");
}

async function gitBuffer(root: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}
