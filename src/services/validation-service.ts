import { createHash, randomUUID } from "node:crypto";
import { access, lstat, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import ignore from "ignore";
import { ValidateInputSchema, type ValidateInput, type ValidateResult, type ValidationProfile } from "../contracts/validation.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { atomicWriteJson } from "../runtime/fs-helpers.js";
import { redactHostPaths, redactSensitiveText } from "../runtime/result-envelope.js";
import { OperationsPolicy } from "./operations-policy.js";
import { validateRepoPath } from "./path-sandbox.js";
import { IgnoreEngine } from "./ignore-engine.js";
import { GitService } from "./git-service.js";
import { NodeRuntimeResolver, type NodeRuntimeResolverOptions, type NodeRuntimeSource } from "./node-runtime-resolver.js";
import { runProcessWithTail } from "./process-exec.js";
import {
  attachValidationArtifactCapture,
  type CapturedValidationCommand
} from "./validation-artifact-capture.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 4_000;
const MAX_CAPTURED_VALIDATION_BYTES = 3_500_000;
const ALL_PROFILE_ORDER = ["typecheck", "lint", "test", "build", "smoke"] as const;
const VALIDATION_ROOT = ".chatgpt/validation";

type CommandPlan = {
  profile: ValidationProfile;
  script: string;
  executable: string;
  command: string;
  args: string[];
  pathPrefix?: string;
  runtime?: { name: "node"; version: string; source: NodeRuntimeSource };
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  executable_sha256?: string;
};

const BLOCKED_EXECUTABLES = new Set(["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]);
const PACKAGE_MANAGERS = new Set(["npm", "npm.cmd", "pnpm", "yarn", "bun"]);
const PACKAGE_MUTATION_ARGS = new Set(["add", "ci", "install", "remove", "uninstall", "update", "upgrade"]);
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|PRIVATE|AUTH|KEY)/i;

const PYTHON_SCAN_EXCLUDES = new Set([".git", ".venv", "venv", "node_modules", "build", "dist", ".cache", ".pytest_cache", "__pycache__", ".tox"]);
const MAX_PYTHON_SCAN_ENTRIES = 2_000;
const MAX_PYTHON_SCAN_DEPTH = 6;

export class ValidationService {
  private readonly ignoreEngine = new IgnoreEngine();

  constructor(
    private readonly root: string,
    private readonly policy: OperationsPolicy,
    private readonly nodeRuntimeOptions: NodeRuntimeResolverOptions = {},
    private readonly hostNodeExecutable: string = process.execPath
  ) {}

  async validate(input: ValidateInput): Promise<ValidateResult> {
    const args = ValidateInputSchema.parse(input);
    this.policy.assertValidationAllowed();
    const scripts = await this.readScripts();
    const testPaths = args.test_paths ? this.validateFocusedTestPaths(args.profile, args.test_paths) : undefined;
    const commands = await this.resolveCommands(args.profile, scripts, testPaths);

    if (args.dry_run === true) {
      return {
        ok: true,
        repo_id: args.repo_id,
        profile: args.profile,
        ...(testPaths ? { focused: true, test_paths: testPaths } : {}),
        dry_run: true,
        status: "skipped",
        commands: commands.map((command) => ({
          profile: command.profile,
          script: command.script,
          command: command.command,
          ...(command.runtime ? { runtime: command.runtime } : {}),
          status: "skipped"
        })),
        counts: { total: commands.length, passed: 0, failed: 0, skipped: commands.length },
        warnings: ["VALIDATION_DRY_RUN"]
      };
    }

    const results: ValidateResult["commands"] = [];
    const capturedCommands: CapturedValidationCommand[] = [];
    let remainingCaptureBytes = MAX_CAPTURED_VALIDATION_BYTES;
    for (const command of commands) {
      const execution = await this.runCommand(command, args.timeout_ms ?? DEFAULT_TIMEOUT_MS, remainingCaptureBytes);
      if (execution.capture.truncated) {
        throw new RepoReaderError("VALIDATION_ARTIFACT_TOO_LARGE", "Validation output exceeds the full-log artifact limit.");
      }
      remainingCaptureBytes -= Buffer.byteLength(execution.capture.stdout, "utf8")
        + Buffer.byteLength(execution.capture.stderr, "utf8");
      results.push(execution.result);
      capturedCommands.push({
        profile: command.profile,
        script: command.script,
        command: command.command,
        status: execution.result.status === "passed" ? "passed" : "failed",
        ...(execution.result.exit_code === undefined ? {} : { exit_code: execution.result.exit_code }),
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
        timed_out: execution.timedOut,
        duration_ms: execution.result.duration_ms ?? 0,
        stdout: redactHostPaths(execution.capture.stdout),
        stderr: redactHostPaths(execution.capture.stderr)
      });
    }
    const failed = results.filter((result) => result.status === "failed").length;
    const passed = results.filter((result) => result.status === "passed").length;
    const validationId = createValidationId();
    const result: ValidateResult = {
      ok: true,
      repo_id: args.repo_id,
      validation_id: validationId,
      profile: args.profile,
      ...(testPaths ? { focused: true, test_paths: testPaths } : {}),
      dry_run: false,
      status: failed > 0 ? "failed" : "passed",
      commands: results,
      counts: { total: results.length, passed, failed, skipped: 0 },
      warnings: []
    };
    const artifactPath = await this.writeValidationArtifact(result);

    return attachValidationArtifactCapture({
      ...result,
      validation_artifact: { path: artifactPath }
    }, {
      schema_version: 1,
      validation_id: validationId,
      repo_id: args.repo_id,
      profile: args.profile,
      status: result.status === "passed" ? "passed" : "failed",
      commands: capturedCommands
    });
  }

  private async readScripts(): Promise<Record<string, string>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.root, "package.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Validation requires a readable package.json or a detected Python test suite.", {
        diagnostics: { recovery_hint: error instanceof Error ? error.message : "package.json could not be read" }
      });
    }

    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }

  private async resolveCommands(profile: ValidationProfile, scripts: Record<string, string>, testPaths: string[] | undefined): Promise<CommandPlan[]> {
    if (testPaths && profile !== "test") {
      throw new RepoReaderError("VALIDATION_TEST_PATHS_REQUIRE_TEST_PROFILE", "Focused test paths are only supported with profile test.");
    }
    const owned = this.policy.config.validation_profiles[profile];
    if (owned) {
      if (testPaths) {
        throw new RepoReaderError("VALIDATION_TEST_PATHS_DISABLED", "Focused test paths are not supported by the declared repository validation profile.");
      }
      if (owned.runner === "exec") {
        const executable = await this.resolveConfiguredExecutable(owned.executable);
        const cwd = await this.resolveConfiguredCwd(owned.cwd);
        assertSafeConfiguredInvocation(executable.path, owned.args, owned.env);
        return [{
          profile,
          script: `exec:${profile}`,
          executable: executable.path,
          command: `${basename(executable.path)} (${profile})`,
          args: owned.args,
          cwd,
          ...(owned.env ? { env: owned.env } : {}),
          ...(owned.timeout_ms ? { timeout_ms: owned.timeout_ms } : {}),
          executable_sha256: executable.sha256
        }];
      }
      return [{
        profile,
        script: `make:${owned.target}`,
        executable: "make",
        command: `make ${owned.target}`,
        args: [owned.target]
      }];
    }
    const npmProfiles = profile === "all"
      ? ALL_PROFILE_ORDER.filter((candidate) => candidate in scripts)
      : profile in scripts
        ? [profile]
        : [];
    const selectedNode = npmProfiles.length > 0
      ? await new NodeRuntimeResolver(this.root, this.nodeRuntimeOptions).resolve()
      : undefined;
    const runtime = selectedNode
      ? { name: selectedNode.name, version: selectedNode.version, source: selectedNode.source }
      : undefined;
    const plans: CommandPlan[] = npmProfiles.map((candidate) => ({
      profile: candidate,
      script: candidate,
      executable: "npm",
      command: testPaths && candidate === "test" ? `npm run test -- ${testPaths.join(" ")}` : `npm run ${candidate}`,
      args: testPaths && candidate === "test" ? ["run", candidate, "--", ...testPaths] : ["run", candidate],
      pathPrefix: selectedNode?.bin_directory ?? dirname(this.hostNodeExecutable),
      ...(runtime ? { runtime } : {})
    }));
    const needsPytest = !("test" in scripts) && (profile === "test" || profile === "all") && await this.hasPythonTestSuite();
    if (needsPytest) {
      const python = await this.selectPython();
      const pytestArgs = [...python.prefixArgs, "-m", "pytest", ...(testPaths ?? [])];
      const pytestPlan: CommandPlan = {
        profile: "test",
        script: "pytest",
        executable: python.executable,
        command: `${python.display} -m pytest${testPaths ? ` ${testPaths.join(" ")}` : ""}`,
        args: pytestArgs
      };
      if (profile === "all") {
        const testIndex = ALL_PROFILE_ORDER.indexOf("test");
        const insertionIndex = plans.findIndex((plan) => profileOrder(plan.profile) > testIndex);
        plans.splice(insertionIndex === -1 ? plans.length : insertionIndex, 0, pytestPlan);
      } else {
        plans.push(pytestPlan);
      }
    }
    if (plans.length === 0 || (profile !== "all" && plans[0]?.profile !== profile)) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", `Validation profile ${profile} is not available from an npm script or safe project runner.`, {
        diagnostics: { recovery_hint: "Add a matching package.json script or, for test, a pytest suite; otherwise choose an available allowlisted profile." }
      });
    }
    return plans;
  }

  private async runCommand(command: CommandPlan, timeoutMs: number, captureBytes: number): Promise<{
    result: ValidateResult["commands"][number];
    capture: { stdout: string; stderr: string; truncated: boolean };
    signal?: string;
    timedOut: boolean;
  }> {
    const result = await runProcessWithTail({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd ?? this.root,
      timeout_ms: Math.min(timeoutMs, command.timeout_ms ?? timeoutMs),
      tail_bytes: OUTPUT_TAIL_CHARS * 4,
      capture_bytes: captureBytes,
      env: {
        PATH: command.pathPrefix ? `${command.pathPrefix}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH ?? "",
        CI: "1",
        NO_COLOR: "1",
        npm_config_color: "false",
        ...command.env
      }
    });
    const passed = result.exit_code === 0 && !result.timed_out;
    return {
      result: {
        profile: command.profile,
        script: command.script,
        command: command.command,
        ...(command.runtime ? { runtime: command.runtime } : {}),
        ...(command.executable_sha256 ? { executable_sha256: command.executable_sha256 } : {}),
        status: passed ? "passed" : "failed",
        ...(typeof result.exit_code === "number" ? { exit_code: result.exit_code } : {}),
        duration_ms: result.duration_ms,
        stdout_tail: tail(result.stdout_tail),
        stderr_tail: tail(result.timed_out ? `${result.stderr_tail}\nCommand timed out after ${timeoutMs}ms.` : result.stderr_tail)
      },
      capture: result.captured_output ?? { stdout: "", stderr: "", truncated: true },
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timed_out
    };
  }

  private async hasPythonTestSuite(): Promise<boolean> {
    for (const marker of ["pyproject.toml", "pytest.ini", "tox.ini"]) {
      try {
        if ((await stat(join(this.root, marker))).isFile()) return true;
      } catch { /* marker absent or inaccessible */ }
    }
    let visited = 0;
    const scan = async (directory: string, depth: number): Promise<boolean> => {
      if (depth > MAX_PYTHON_SCAN_DEPTH || visited >= MAX_PYTHON_SCAN_ENTRIES) return false;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return false; }
      for (const entry of entries) {
        if (++visited > MAX_PYTHON_SCAN_ENTRIES) return false;
        if (entry.isFile() && (entry.name.startsWith("test_") || entry.name.endsWith("_test.py")) && entry.name.endsWith(".py")) return true;
        if (entry.isDirectory() && !PYTHON_SCAN_EXCLUDES.has(entry.name) && await scan(join(directory, entry.name), depth + 1)) return true;
      }
      return false;
    };
    return scan(this.root, 0);
  }

  private async resolveConfiguredExecutable(configuredPath: string): Promise<{ path: string; sha256: string }> {
    if (!isAbsolute(configuredPath)) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation executable is not absolute.");
    }
    const [linkInfo, resolved] = await Promise.all([lstat(configuredPath), realpath(configuredPath)]);
    if (!linkInfo.isFile() && !linkInfo.isSymbolicLink()) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation executable is not a regular file.");
    }
    const resolvedInfo = await stat(resolved);
    if (!resolvedInfo.isFile()) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation executable does not resolve to a regular file.");
    }
    await access(resolved, fsConstants.X_OK);
    return { path: resolved, sha256: await sha256File(resolved) };
  }

  private async resolveConfiguredCwd(configuredCwd: string | undefined): Promise<string> {
    if (!configuredCwd) return this.root;
    if (isAbsolute(configuredCwd) || configuredCwd.split("/").includes("..") || configuredCwd.includes("\\")) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation cwd must be a safe repository-relative path.");
    }
    const [rootReal, cwdReal] = await Promise.all([realpath(this.root), realpath(join(this.root, configuredCwd))]);
    if (!isWithinRoot(rootReal, cwdReal) || !(await stat(cwdReal)).isDirectory()) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation cwd escapes the repository or is not a directory.");
    }
    return cwdReal;
  }

  private async selectPython(): Promise<{ executable: string; prefixArgs: string[]; display: string }> {
    const localCandidates = process.platform === "win32"
      ? [[".venv", "Scripts", "python.exe"], ["venv", "Scripts", "python.exe"]]
      : [[".venv", "bin", "python"], ["venv", "bin", "python"]];
    for (const parts of localCandidates) {
      const candidate = join(this.root, ...parts);
      if (await this.isSafeLocalExecutable(candidate)) {
        return { executable: candidate, prefixArgs: [], display: parts.join("/") };
      }
    }
    if (process.platform === "win32") {
      if (await isExecutableOnPath("py")) return { executable: "py", prefixArgs: ["-3"], display: "py -3" };
      return { executable: "python", prefixArgs: [], display: "python" };
    }
    if (await isExecutableOnPath("python3")) return { executable: "python3", prefixArgs: [], display: "python3" };
    return { executable: "python", prefixArgs: [], display: "python" };
  }

  private async isSafeLocalExecutable(candidate: string): Promise<boolean> {
    if (!isWithinRoot(this.root, candidate)) return false;
    try {
      const linkInfo = await lstat(candidate);
      if (!linkInfo.isFile() && !linkInfo.isSymbolicLink()) return false;
      const [resolvedRoot, resolved] = await Promise.all([realpath(this.root), realpath(candidate)]);
      if (!isWithinRoot(resolvedRoot, resolved) || !(await stat(resolved)).isFile()) return false;
      await access(resolved, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private validateFocusedTestPaths(profile: ValidationProfile, paths: string[]): string[] {
    if (profile !== "test") {
      throw new RepoReaderError("VALIDATION_TEST_PATHS_REQUIRE_TEST_PROFILE", "Focused test paths are only supported with profile test.");
    }
    if (this.policy.config.validation_test_path_globs.length === 0) {
      throw new RepoReaderError("VALIDATION_TEST_PATHS_DISABLED", "Focused test paths are not enabled for this repository.");
    }
    if (paths.length === 0) {
      throw new RepoReaderError("VALIDATION_TEST_PATHS_REQUIRED", "At least one focused test path is required.");
    }
    if (paths.length > this.policy.config.max_paths_per_operation) {
      throw new RepoReaderError("VALIDATION_TOO_MANY_TEST_PATHS", `Too many focused test paths: ${paths.length}`);
    }
    const matcher = ignore().add(this.policy.config.validation_test_path_globs);
    return [...new Set(paths.map((path) => validateRepoPath(path)))].sort().map((path) => {
      if (this.ignoreEngine.isSensitiveCandidate(path)) {
        throw new RepoReaderError("SECRET_CANDIDATE_BLOCKED", `Validation test path blocks secret-looking path: ${path}`);
      }
      if (!matcher.ignores(path)) {
        throw new RepoReaderError("VALIDATION_TEST_PATH_NOT_ALLOWED", `Focused validation path is outside validation_test_path_globs: ${path}`);
      }
      return path;
    });
  }

  private async writeValidationArtifact(result: ValidateResult): Promise<string> {
    const validationId = result.validation_id;
    if (!validationId) {
      throw new RepoReaderError("VALIDATION_ARTIFACT_WRITE_FAILED", "Validation id missing before artifact write.");
    }
    const [headSha, worktreeFingerprint] = await Promise.all([
      this.currentHeadSha(),
      this.currentWorktreeFingerprint()
    ]);
    const artifactPath = `${VALIDATION_ROOT}/${validationId}/result.json`;
    const artifact = {
      schema_version: 1,
      validation_id: validationId,
      repo_id: result.repo_id,
      profile: result.profile,
      ...(result.focused ? { focused: result.focused, test_paths: result.test_paths ?? [] } : {}),
      status: result.status,
      head_sha: headSha,
      worktree_fingerprint: worktreeFingerprint,
      timestamp: new Date().toISOString(),
      commands: result.commands,
      counts: result.counts,
      warnings: result.warnings
    };
    await atomicWriteJson(join(this.root, artifactPath), artifact);
    await atomicWriteJson(join(this.root, VALIDATION_ROOT, "latest.json"), {
      schema_version: 1,
      validation_id: validationId,
      repo_id: result.repo_id,
      profile: result.profile,
      ...(result.focused ? { focused: result.focused, test_paths: result.test_paths ?? [] } : {}),
      status: result.status,
      head_sha: headSha,
      worktree_fingerprint: worktreeFingerprint,
      artifact_path: artifactPath,
      timestamp: artifact.timestamp
    });
    return artifactPath;
  }

  private async currentHeadSha(): Promise<string | undefined> {
    try {
      return (await new GitService(this.root).status()).head_sha;
    } catch {
      return undefined;
    }
  }

  private async currentWorktreeFingerprint(): Promise<string | undefined> {
    try {
      return await new GitService(this.root).worktreeFingerprint();
    } catch {
      return "unavailable";
    }
  }
}

function tail(value: string | Buffer | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = redactSensitiveText(String(value)).trimEnd();
  if (text.length === 0) {
    return undefined;
  }
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;
}

function createValidationId(): string {
  return `validation-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function assertSafeConfiguredInvocation(
  executable: string,
  args: string[],
  env: Record<string, string> | undefined
): void {
  const executableName = basename(executable).toLowerCase();
  if (BLOCKED_EXECUTABLES.has(executableName)) {
    throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Shell executables are prohibited in validation profiles.");
  }
  if (PACKAGE_MANAGERS.has(executableName) && args.some((arg) => PACKAGE_MUTATION_ARGS.has(arg.toLowerCase()))) {
    throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Dependency installation and mutation are prohibited at validation runtime.");
  }
  if (args.some((arg) => arg.includes("\0"))) {
    throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Validation arguments contain an invalid NUL byte.");
  }
  for (const [name, value] of Object.entries(env ?? {})) {
    if (SENSITIVE_ENV_NAME.test(name)) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Credential-bearing environment names are prohibited in validation profiles.");
    }
    if (value.includes("\0")) {
      throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Validation environment contains an invalid NUL byte.");
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > 512 * 1_024 * 1_024) {
        throw new RepoReaderError("VALIDATION_PROFILE_UNAVAILABLE", "Configured validation executable exceeds the identity-check size limit.");
      }
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

function profileOrder(profile: ValidationProfile): number {
  const index = ALL_PROFILE_ORDER.indexOf(profile as typeof ALL_PROFILE_ORDER[number]);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function isExecutableOnPath(name: "python3" | "py"): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" && name === "py" ? "py.exe" : name);
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch { /* try the next fixed PATH entry */ }
  }
  return false;
}
