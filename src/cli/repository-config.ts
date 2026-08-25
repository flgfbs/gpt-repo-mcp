import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_RUNTIME_ROOT,
  MergeMethodSchema,
  RepositoryAuthoritySchema,
  type RepoReaderConfig
} from "../config/schema.js";
import { loadConfig } from "../config/store.js";
import { validateConfigDocument } from "../config/validation.js";
import { DEFAULT_OPERATIONS_POLICY, SHIP_VALIDATION_TEST_PATH_GLOBS } from "../policies/operations-defaults.js";
import { DEFAULT_WRITE_POLICY } from "../policies/write-defaults.js";
import { githubRepositoryFromIdentity, normalizeRemoteIdentity } from "../services/remote-identity.js";
import type { OwnerCliIo } from "./cli-types.js";
import { OwnerCliError } from "./cli-types.js";
import type { OwnerTaskStateReader } from "./task-state-reader.js";

const execFileAsync = promisify(execFile);

type Authority = "read" | "write" | "ship";
type MergeMethod = "merge" | "squash" | "rebase";

type AddOptions = {
  path?: string;
  repoId?: string;
  displayName?: string;
  authority?: Authority;
  remoteName: string;
  expectedRemoteIdentity?: string;
  baseBranches: string[];
  worktreeRoot?: string;
  githubRepository?: string;
  mergeMethod: MergeMethod;
  requiredChecks: string[];
  localOnly: boolean;
  githubOptionsExplicit: boolean;
  requireCleanBase: boolean;
  maxConcurrentTasks: number;
  cleanup: {
    remove_worktree: boolean;
    delete_local_branch: boolean;
    require_terminal_task: boolean;
  };
};

export async function addRepository(args: string[], configPath: string, io: OwnerCliIo): Promise<number> {
  const options = parseAddOptions(args);
  if (!options.path) throw new OwnerCliError("USAGE", "Usage: chat-pro-repo repo add <path> [options]");
  const authority = options.authority ?? "read";
  const root = await canonicalGitRoot(resolve(io.cwd, options.path));
  const displayName = options.displayName ?? basename(root);
  const repoId = normalizeRepoId(options.repoId ?? displayName);
  if (!repoId) throw new OwnerCliError("INVALID_REPO_ID", "Repository id must contain an ASCII letter or digit.");

  const config = await loadConfig(configPath);
  const existingValidation = await validateConfigDocument(config);
  if (existingValidation.issues.length > 0) {
    throw new OwnerCliError(
      "CONFIG_VALIDATION_FAILED",
      `Existing configuration is invalid: ${existingValidation.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`
    );
  }
  const canonicalExistingRoots = await Promise.all(config.repos.map(async (repo) => realpath(repo.root)));
  if (config.repos.some((repo) => repo.repo_id === repoId)) {
    throw new OwnerCliError("DUPLICATE_REPO_ID", `Repository id already exists: ${repoId}`);
  }
  if (canonicalExistingRoots.includes(root)) {
    throw new OwnerCliError("DUPLICATE_ROOT", "Canonical repository root is already registered.");
  }

  if (options.localOnly && options.githubOptionsExplicit) {
    throw new OwnerCliError(
      "LOCAL_ONLY_OPTION_CONFLICT",
      "--local-only cannot be combined with remote, GitHub, merge-method, or required-check options."
    );
  }

  let remoteIdentity: string | undefined;
  let githubRepository: string | undefined;
  if (!options.localOnly) {
    remoteIdentity = await inspectRemoteIdentity(root, options.remoteName);
    if (options.expectedRemoteIdentity) {
      const requested = normalizeRemoteIdentity(options.expectedRemoteIdentity);
      if (requested !== remoteIdentity) {
        throw new OwnerCliError("REMOTE_IDENTITY_MISMATCH", "Configured Git remote does not match --expected-remote-identity.");
      }
    }
    const derivedGitHub = githubRepositoryFromIdentity(remoteIdentity);
    if (!derivedGitHub) {
      throw new OwnerCliError("GITHUB_REMOTE_REQUIRED", "GitHub lifecycle registration requires a credential-safe github.com remote identity.");
    }
    githubRepository = options.githubRepository ?? derivedGitHub;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
      throw new OwnerCliError("GITHUB_REPOSITORY_REQUIRED", "Use --github-repository <owner/name> for this remote identity.");
    }
    if (derivedGitHub.toLowerCase() !== githubRepository.toLowerCase()) {
      throw new OwnerCliError("GITHUB_REPOSITORY_MISMATCH", "GitHub owner/name does not match the configured remote.");
    }
  }

  const baseBranches = options.baseBranches.length > 0
    ? unique(options.baseBranches)
    : [await currentBranch(root)];
  for (const branch of baseBranches) await verifyLocalBranch(root, branch);

  const runtimeRoot = resolve(config.runtime_root ?? DEFAULT_RUNTIME_ROOT);
  const worktreeRootInput = options.worktreeRoot
    ? resolve(io.cwd, options.worktreeRoot)
    : join(runtimeRoot, "worktrees", repoId);
  assertRootsDoNotOverlap(root, runtimeRoot, "Runtime root");
  assertRootsDoNotOverlap(root, worktreeRootInput, "Worktree root");
  for (const repo of config.repos) {
    assertRootsDoNotOverlap(repo.root, worktreeRootInput, "Worktree root");
    if (repo.lifecycle) assertRootsDoNotOverlap(repo.lifecycle.worktree_root, worktreeRootInput, "Worktree root");
  }
  await ensureOwnerDirectory(runtimeRoot, "Runtime root");
  const worktreeRoot = await ensureOwnerDirectory(worktreeRootInput, "Worktree root");

  const lifecycle: NonNullable<RepoReaderConfig["repos"][number]["lifecycle"]> = options.localOnly
    ? {
        kind: "local",
        authority,
        allowed_base_branches: baseBranches,
        worktree_root: worktreeRoot,
        require_clean_base: options.requireCleanBase,
        max_concurrent_tasks: options.maxConcurrentTasks,
        cleanup: options.cleanup
      }
    : {
        kind: "github",
        authority,
        remote_name: options.remoteName,
        expected_remote_identity: remoteIdentity!,
        allowed_base_branches: baseBranches,
        worktree_root: worktreeRoot,
        github_repository: githubRepository!,
        merge_method: options.mergeMethod,
        required_checks: unique(options.requiredChecks),
        require_clean_base: options.requireCleanBase,
        max_concurrent_tasks: options.maxConcurrentTasks,
        cleanup: options.cleanup
      };

  const next: RepoReaderConfig = {
    ...config,
    runtime_root: runtimeRoot,
    repos: [...config.repos, {
      repo_id: repoId,
      display_name: displayName,
      root,
      ...authorityPolicies(authority),
      lifecycle
    }]
  };
  const validation = await validateConfigDocument(next);
  if (validation.issues.length > 0) {
    throw new OwnerCliError(
      "CONFIG_VALIDATION_FAILED",
      `Repository policy was not written: ${validation.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`
    );
  }
  await writePrivateConfig(configPath, next);

  io.stdout(`repo_id=${repoId}`);
  io.stdout(`display_name=${displayName}`);
  io.stdout(`root=${root}`);
  io.stdout(`authority=${authority}`);
  io.stdout(`lifecycle_kind=${options.localOnly ? "local" : "github"}`);
  io.stdout(`remote_name=${options.localOnly ? "-" : options.remoteName}`);
  io.stdout(`expected_remote_identity=${remoteIdentity ?? "-"}`);
  io.stdout(`allowed_base_branches=${baseBranches.join(",")}`);
  io.stdout(`worktree_root=${worktreeRoot}`);
  io.stdout(`github_repository=${githubRepository ?? "-"}`);
  io.stdout(`merge_method=${options.localOnly ? "-" : options.mergeMethod}`);
  io.stdout(`required_checks=${options.localOnly ? "-" : unique(options.requiredChecks).join(",")}`);
  io.stdout(`cleanup_remove_worktree=${String(options.cleanup.remove_worktree)}`);
  io.stdout(`cleanup_delete_local_branch=${String(options.cleanup.delete_local_branch)}`);
  io.stdout(`cleanup_require_terminal_task=${String(options.cleanup.require_terminal_task)}`);
  return 0;
}

export async function listRepositories(configPath: string, io: OwnerCliIo): Promise<number> {
  const config = await loadConfig(configPath);
  const validation = await validateConfigDocument(config);
  const repos = validation.repositories ?? validation.config!.repos;
  if (repos.length === 0) {
    io.stdout("No repositories registered.");
  } else {
    io.stdout("repo_id\tdisplay_name\tauthority\tgithub_repository\tallowed_base_branches\troot");
    for (const repo of [...repos].sort((left, right) => left.repo_id.localeCompare(right.repo_id))) {
      io.stdout([
        repo.repo_id,
        repo.display_name,
        repo.lifecycle?.authority ?? (repo.writes.enabled ? "write" : "read"),
        repo.lifecycle?.kind === "github" ? repo.lifecycle.github_repository : "-",
        repo.lifecycle?.allowed_base_branches.join(",") ?? "-",
        repo.root
      ].join("\t"));
    }
  }
  if (validation.issues.length > 0) {
    io.stderr(`FAIL ${validation.issues.length} configuration issue(s); explicit entries are listed for diagnosis.`);
    for (const issue of validation.issues) io.stderr(`- [${issue.code}] ${issue.message}`);
    return 1;
  }
  return 0;
}

export async function addProjectRoot(args: string[], configPath: string, io: OwnerCliIo): Promise<number> {
  const options = parseProjectRootAddOptions(args);
  if (!options.path) throw new OwnerCliError("USAGE", "Usage: chat-pro-repo project-root add <path> [options]");
  const root = await canonicalOwnerDirectory(resolve(io.cwd, options.path), "Project root");
  const projectRootId = normalizeRepoId(options.projectRootId ?? basename(root));
  if (!projectRootId) throw new OwnerCliError("INVALID_PROJECT_ROOT_ID", "Project root id must contain an ASCII letter or digit.");

  const config = await loadConfig(configPath);
  const existingValidation = await validateConfigDocument(config);
  if (existingValidation.issues.length > 0) {
    throw new OwnerCliError(
      "CONFIG_VALIDATION_FAILED",
      `Existing configuration is invalid: ${existingValidation.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`
    );
  }
  const projectRoots = config.project_roots ?? [];
  if (projectRoots.some((entry) => entry.project_root_id === projectRootId)) {
    throw new OwnerCliError("DUPLICATE_PROJECT_ROOT_ID", `Project root id already exists: ${projectRootId}`);
  }
  const canonicalExistingRoots = await Promise.all(projectRoots.map(async (entry) => realpath(entry.root)));
  if (canonicalExistingRoots.includes(root)) {
    throw new OwnerCliError("DUPLICATE_PROJECT_ROOT", "Canonical project root is already registered.");
  }

  const next: RepoReaderConfig = {
    ...config,
    project_roots: [...projectRoots, {
      project_root_id: projectRootId,
      root,
      ...(options.repoIdPrefix ? { repo_id_prefix: options.repoIdPrefix } : {}),
      exclude_directories: unique(options.excludeDirectories)
    }]
  };
  const validation = await validateConfigDocument(next);
  if (validation.issues.length > 0) {
    throw new OwnerCliError(
      "CONFIG_VALIDATION_FAILED",
      `Project root was not written: ${validation.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`
    );
  }
  await writePrivateConfig(configPath, next);

  io.stdout(`project_root_id=${projectRootId}`);
  io.stdout(`root=${root}`);
  io.stdout("mode=read");
  io.stdout(`repo_id_prefix=${options.repoIdPrefix ?? "-"}`);
  io.stdout(`exclude_directories=${unique(options.excludeDirectories).join(",")}`);
  io.stdout(`approved_repository_count=${validation.repositories!.length}`);
  io.stdout("restart_required=true");
  return 0;
}

export async function listProjectRoots(configPath: string, io: OwnerCliIo): Promise<number> {
  const config = await loadConfig(configPath);
  const projectRoots = config.project_roots ?? [];
  if (projectRoots.length === 0) {
    io.stdout("No project roots registered.");
    return 0;
  }
  io.stdout("project_root_id\tmode\trepo_id_prefix\texclude_directories\troot");
  for (const projectRoot of [...projectRoots].sort((left, right) => left.project_root_id.localeCompare(right.project_root_id))) {
    io.stdout([
      projectRoot.project_root_id,
      "read",
      projectRoot.repo_id_prefix ?? "-",
      projectRoot.exclude_directories?.join(",") ?? "-",
      projectRoot.root
    ].join("\t"));
  }
  return 0;
}

export async function removeProjectRoot(args: string[], configPath: string, io: OwnerCliIo): Promise<number> {
  if (args.length !== 1) throw new OwnerCliError("USAGE", "Usage: chat-pro-repo project-root remove <project_root_id>");
  const projectRootId = args[0]!;
  const config = await loadConfig(configPath);
  const projectRoots = config.project_roots ?? [];
  const index = projectRoots.findIndex((entry) => entry.project_root_id === projectRootId);
  if (index < 0) throw new OwnerCliError("UNKNOWN_PROJECT_ROOT", `Project root is not registered: ${projectRootId}`);
  const [removed] = projectRoots.splice(index, 1);
  config.project_roots = projectRoots;
  await writePrivateConfig(configPath, config);
  io.stdout(`removed_project_root_id=${removed!.project_root_id}`);
  io.stdout("repository_data_deleted=false");
  io.stdout("restart_required=true");
  return 0;
}

export async function removeRepository(
  args: string[],
  configPath: string,
  io: OwnerCliIo,
  taskReaderFactory: (runtimeRoot: string) => OwnerTaskStateReader
): Promise<number> {
  if (args.length !== 1) throw new OwnerCliError("USAGE", "Usage: chat-pro-repo repo remove <repo_id>");
  const repoId = args[0]!;
  const config = await loadConfig(configPath);
  const index = config.repos.findIndex((repo) => repo.repo_id === repoId);
  if (index < 0) throw new OwnerCliError("UNKNOWN_REPO", `Repository id is not registered: ${repoId}`);

  const tasks = await taskReaderFactory(resolve(config.runtime_root ?? DEFAULT_RUNTIME_ROOT)).listTasks(10_000);
  const retained = tasks.filter((task) => task.base_repo_id === repoId && task.lifecycle !== "CLEANED");
  if (retained.length > 0) {
    throw new OwnerCliError(
      "ACTIVE_TASKS_PRESENT",
      `Repository cannot be removed while durable tasks remain: ${retained.map((task) => `${task.task_id}:${task.lifecycle}`).join(", ")}`
    );
  }

  const [removed] = config.repos.splice(index, 1);
  await writePrivateConfig(configPath, config);
  io.stdout(`removed_repo_id=${removed!.repo_id}`);
  io.stdout("repository_data_deleted=false");
  return 0;
}

function parseAddOptions(args: string[]): AddOptions {
  const options: AddOptions = {
    remoteName: "origin",
    baseBranches: [],
    mergeMethod: "squash",
    requiredChecks: [],
    localOnly: false,
    githubOptionsExplicit: false,
    requireCleanBase: true,
    maxConcurrentTasks: 8,
    cleanup: { remove_worktree: true, delete_local_branch: true, require_terminal_task: true }
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (options.path) throw new OwnerCliError("USAGE", `Unexpected argument: ${arg}`);
      options.path = arg;
      continue;
    }
    if (arg === "--read" || arg === "--write" || arg === "--ship") {
      options.authority = setAuthority(options.authority, arg.slice(2));
      continue;
    }
    if (arg === "--local-only") {
      options.localOnly = true;
      continue;
    }
    if (arg === "--allow-dirty-base") {
      options.requireCleanBase = false;
      continue;
    }
    if (arg === "--keep-worktree") {
      options.cleanup.remove_worktree = false;
      continue;
    }
    if (arg === "--keep-local-branch") {
      options.cleanup.delete_local_branch = false;
      continue;
    }
    if (arg === "--allow-nonterminal-cleanup") {
      options.cleanup.require_terminal_task = false;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new OwnerCliError("USAGE", `Missing value for ${arg}.`);
    index += 1;
    switch (arg) {
      case "--id": options.repoId = value; break;
      case "--name": options.displayName = value; break;
      case "--mode":
      case "--authority": options.authority = setAuthority(options.authority, value); break;
      case "--remote-name": options.remoteName = value; options.githubOptionsExplicit = true; break;
      case "--expected-remote-identity": options.expectedRemoteIdentity = value; options.githubOptionsExplicit = true; break;
      case "--base": options.baseBranches.push(value); break;
      case "--worktree-root": options.worktreeRoot = value; break;
      case "--github-repository": options.githubRepository = value; options.githubOptionsExplicit = true; break;
      case "--merge-method": options.mergeMethod = MergeMethodSchema.parse(value); options.githubOptionsExplicit = true; break;
      case "--required-check": options.requiredChecks.push(value); options.githubOptionsExplicit = true; break;
      case "--max-concurrent-tasks": options.maxConcurrentTasks = parsePositiveInteger(value, arg, 64); break;
      default: throw new OwnerCliError("USAGE", `Unknown option: ${arg}`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.remoteName)) {
    throw new OwnerCliError("INVALID_REMOTE_NAME", "Remote name is invalid.");
  }
  return options;
}

function parseProjectRootAddOptions(args: string[]): {
  path?: string;
  projectRootId?: string;
  repoIdPrefix?: string;
  excludeDirectories: string[];
} {
  const options: {
    path?: string;
    projectRootId?: string;
    repoIdPrefix?: string;
    excludeDirectories: string[];
  } = { excludeDirectories: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      if (options.path) throw new OwnerCliError("USAGE", `Unexpected argument: ${arg}`);
      options.path = arg;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new OwnerCliError("USAGE", `Missing value for ${arg}.`);
    index += 1;
    switch (arg) {
      case "--id": options.projectRootId = normalizeRepoId(value); break;
      case "--repo-id-prefix": options.repoIdPrefix = normalizeRepoId(value); break;
      case "--exclude": options.excludeDirectories.push(value); break;
      default: throw new OwnerCliError("USAGE", `Unknown option: ${arg}`);
    }
  }
  if (options.repoIdPrefix === "") {
    throw new OwnerCliError("INVALID_REPO_ID_PREFIX", "Repository id prefix must contain an ASCII letter or digit.");
  }
  return options;
}

function setAuthority(current: Authority | undefined, value: string): Authority {
  const authority = RepositoryAuthoritySchema.parse(value);
  if (current && current !== authority) throw new OwnerCliError("AUTHORITY_CONFLICT", "Repository authority was specified more than once with different values.");
  return authority;
}

function authorityPolicies(authority: Authority): Pick<RepoReaderConfig["repos"][number], "writes" | "operations"> {
  if (authority === "read") return { writes: { enabled: false }, operations: { enabled: false } };
  const writes = { ...DEFAULT_WRITE_POLICY, enabled: true, allowed_globs: ["**"] };
  if (authority === "write") return { writes, operations: { enabled: false } };
  return {
    writes,
    operations: {
      ...DEFAULT_OPERATIONS_POLICY,
      enabled: true,
      git_stage_enabled: true,
      git_commit_enabled: true,
      validation_enabled: true,
      validation_test_path_globs: SHIP_VALIDATION_TEST_PATH_GLOBS,
      validation_profiles: {},
      cleanup_enabled: true
    }
  };
}

async function canonicalGitRoot(inputPath: string): Promise<string> {
  const direct = await lstat(inputPath);
  if (!direct.isDirectory() || direct.isSymbolicLink()) {
    throw new OwnerCliError("REPOSITORY_ROOT_UNSAFE", "Repository root must be a real directory, not a symlink.");
  }
  const root = await realpath(inputPath);
  let topLevel: string;
  try {
    topLevel = (await runGit(root, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new OwnerCliError("NOT_GIT_REPOSITORY", "Repository root is not an exact Git worktree.");
  }
  if (await realpath(topLevel) !== root) {
    throw new OwnerCliError("REPOSITORY_ROOT_NOT_TOPLEVEL", "Path must be the exact Git worktree top level.");
  }
  return root;
}

async function inspectRemoteIdentity(root: string, remoteName: string): Promise<string> {
  let output: string;
  try {
    output = await runGit(root, ["remote", "get-url", "--all", remoteName]);
  } catch {
    throw new OwnerCliError("REMOTE_IDENTITY_UNAVAILABLE", `Remote identity is unavailable for remote ${remoteName}.`);
  }
  const urls = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (urls.length !== 1) {
    throw new OwnerCliError("REMOTE_IDENTITY_AMBIGUOUS", "Lifecycle remote must have exactly one configured fetch URL.");
  }
  return normalizeRemoteIdentity(urls[0]!);
}

async function currentBranch(root: string): Promise<string> {
  const branch = (await runGit(root, ["branch", "--show-current"])).trim();
  if (!branch) throw new OwnerCliError("BASE_BRANCH_REQUIRED", "Detached repositories require at least one --base <branch>.");
  return branch;
}

async function verifyLocalBranch(root: string, branch: string): Promise<void> {
  if (!/^(?!\/|.*(?:\.\.|@\{|\\|\s))[A-Za-z0-9._/-]{1,200}$/.test(branch)) {
    throw new OwnerCliError("INVALID_BASE_BRANCH", `Invalid base branch: ${branch}`);
  }
  try {
    await runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
  } catch {
    throw new OwnerCliError("BASE_BRANCH_MISSING", `Local base branch does not exist: ${branch}`);
  }
}

async function ensureOwnerDirectory(path: string, label: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
    throw new OwnerCliError("OWNER_DIRECTORY_UNSAFE", `${label} must be an owner-controlled real directory.`);
  }
  await chmod(path, 0o700);
  return realpath(path);
}

export async function writePrivateConfig(configPath: string, config: RepoReaderConfig): Promise<void> {
  const existing = await lstat(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new OwnerCliError("CONFIG_PATH_UNSAFE", "Configuration path must be a regular file, not a symlink.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (existing && uid !== undefined && existing.uid !== uid) {
    throw new OwnerCliError("CONFIG_PATH_UNSAFE", "Configuration file must be owned by the current user.");
  }
  const parent = dirname(configPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(configPath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, configPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await chmod(configPath, 0o600);
  const written = await lstat(configPath);
  if (
    !written.isFile()
    || written.isSymbolicLink()
    || written.nlink !== 1
    || (written.mode & 0o777) !== 0o600
    || (uid !== undefined && written.uid !== uid)
  ) {
    throw new OwnerCliError("CONFIG_PRIVACY_INVALID", "Configuration file was not written as a private mode-0600 file.");
  }
  const parentHandle = await open(parent, constants.O_RDONLY);
  try {
    await parentHandle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await parentHandle.close();
  }
}

async function canonicalOwnerDirectory(path: string, label: string): Promise<string> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new OwnerCliError("OWNER_DIRECTORY_UNSAFE", `${label} must be a real directory, not a symlink.`);
  }
  return realpath(path);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    encoding: "utf8"
  });
  return result.stdout;
}

function normalizeRepoId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parsePositiveInteger(value: string, option: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new OwnerCliError("INVALID_NUMBER", `${option} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function assertRootsDoNotOverlap(left: string, right: string, label: string): void {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new OwnerCliError("LIFECYCLE_ROOT_OVERLAP", `${label} must not overlap a registered repository or worktree root.`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.includes(`..${sep}`));
}
