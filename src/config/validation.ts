import { execFile } from "node:child_process";
import { lstat, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { isNotFoundError } from "../runtime/fs-helpers.js";
import { RepoReaderConfigSchema, type ParsedRepoReaderConfig, type RepoReaderConfig } from "./schema.js";
import { expandProjectRepositories, ProjectRootDiscoveryError } from "./project-root-discovery.js";
import { githubRepositoryFromIdentity, normalizeRemoteIdentity } from "../services/remote-identity.js";

const execFileAsync = promisify(execFile);

export type ConfigIssue = {
  code: string;
  message: string;
};

export type ConfigWarning = {
  code: string;
  message: string;
};

export async function validateConfigDocument(document: unknown): Promise<{
  config?: ParsedRepoReaderConfig;
  repositories?: ParsedRepoReaderConfig["repos"];
  issues: ConfigIssue[];
  warnings: ConfigWarning[];
}> {
  const parsed = RepoReaderConfigSchema.safeParse(document);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        code: "SCHEMA_INVALID",
        message: `${formatPath(issue.path)}: ${issue.message}`
      })),
      warnings: []
    };
  }

  const config = parsed.data;
  const rawRepos = getRawRepos(document);
  const issues: ConfigIssue[] = [];
  const warnings: ConfigWarning[] = [];

  const seenIds = new Set<string>();
  for (const repo of config.repos) {
    if (seenIds.has(repo.repo_id)) {
      issues.push({
        code: "DUPLICATE_REPO_ID",
        message: `Duplicate repo_id "${repo.repo_id}".`
      });
      continue;
    }
    seenIds.add(repo.repo_id);
  }

  const seenRoots = new Map<string, string>();
  const lifecycleRepoRoots: Array<{ repo_id: string; root: string }> = [];
  const lifecycleWorktreeRoots: Array<{ repo_id: string; root: string }> = [];
  for (const [index, repo] of config.repos.entries()) {
    const rootPath = resolve(repo.root);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(rootPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        issues.push({
          code: "ROOT_MISSING",
          message: `Root does not exist for repo_id "${repo.repo_id}": ${repo.root}`
        });
        continue;
      }
      throw error;
    }

    if (!stats.isDirectory()) {
      issues.push({
        code: "ROOT_NOT_DIRECTORY",
        message: `Root is not a directory for repo_id "${repo.repo_id}": ${repo.root}`
      });
      continue;
    }

    const canonicalRoot = await realpath(rootPath);
    const duplicateOwner = seenRoots.get(canonicalRoot);
    if (duplicateOwner) {
      issues.push({
        code: "DUPLICATE_ROOT",
        message: `Duplicate root detected for repo_id "${repo.repo_id}" and "${duplicateOwner}": ${canonicalRoot}`
      });
      continue;
    }
    seenRoots.set(canonicalRoot, repo.repo_id);

    if (!repo.allow_non_git && !await looksLikeGitRepository(canonicalRoot)) {
      issues.push({
        code: "NOT_GIT_REPO",
        message: `Root is not a git repository for repo_id "${repo.repo_id}": ${canonicalRoot}`
      });
    }

    if (repo.lifecycle) {
      lifecycleRepoRoots.push({ repo_id: repo.repo_id, root: canonicalRoot });
      if (repo.allow_non_git) {
        issues.push({
          code: "LIFECYCLE_REQUIRES_GIT",
          message: `Lifecycle policy cannot be combined with allow_non_git for repo_id "${repo.repo_id}".`
        });
      } else {
        const worktreeRoot = await validateLifecycleRepository(repo, canonicalRoot, issues);
        if (worktreeRoot) {
          lifecycleWorktreeRoots.push({ repo_id: repo.repo_id, root: worktreeRoot });
        }
      }
    }

    const writeGlobs = [
      ...(repo.writes?.allowed_globs ?? []),
      ...(repo.writes?.denied_globs ?? [])
    ];
    for (const glob of writeGlobs) {
      if (glob.trim().length === 0) {
        issues.push({
          code: "WRITE_GLOB_INVALID",
          message: `Write policy contains an empty glob for repo_id "${repo.repo_id}".`
        });
      }
    }

    const rawOperations = getRawOperations(rawRepos[index]);
    if (isShipLikeWithoutValidation(rawOperations)) {
      const explicitlyDisabled = hasOwn(rawOperations, "validation_enabled");
      warnings.push({
        code: "VALIDATION_NOT_ENABLED",
        message: explicitlyDisabled
          ? `Repo "${repo.repo_id}" explicitly disables validation for ship-like local operations. Runtime config preserves this opt-out.`
          : `Repo "${repo.repo_id}" uses legacy ship-like local operations with operations.validation_enabled omitted. Runtime config enables validation for this legacy shape; add validation_enabled explicitly to silence this warning.`
      });
    }
    if (isShipLikeWithoutFocusedValidation(repo.operations)) {
      warnings.push({
        code: "SHIP_VALIDATION_TEST_PATHS_NOT_CONFIGURED",
        message: `Repo "${repo.repo_id}" enables ship-like local operations without operations.validation_test_path_globs. Add focused test path globs for trusted ship-mode repos.`
      });
    }
  }

  validateLifecycleRootSeparation(lifecycleRepoRoots, lifecycleWorktreeRoots, issues);

  let repositories: ParsedRepoReaderConfig["repos"] | undefined;
  if (issues.length === 0) {
    try {
      repositories = await expandProjectRepositories(config);
    } catch (error) {
      if (error instanceof ProjectRootDiscoveryError) {
        issues.push({ code: error.code, message: error.message });
      } else {
        throw error;
      }
    }
  }

  return { config, repositories, issues, warnings };
}

function isShipLikeWithoutValidation(operations: RepoReaderConfig["repos"][number]["operations"]): boolean {
  return Boolean(
    operations?.enabled
      && operations.git_stage_enabled
      && operations.git_commit_enabled
      && operations.cleanup_enabled
      && !operations.validation_enabled
  );
}

function getRawRepos(document: unknown): unknown[] {
  if (!document || typeof document !== "object" || !("repos" in document)) {
    return [];
  }
  const repos = (document as { repos?: unknown }).repos;
  return Array.isArray(repos) ? repos : [];
}

function getRawOperations(repo: unknown): RepoReaderConfig["repos"][number]["operations"] {
  if (!repo || typeof repo !== "object" || !("operations" in repo)) {
    return undefined;
  }
  return (repo as { operations?: RepoReaderConfig["repos"][number]["operations"] }).operations;
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function isShipLikeWithoutFocusedValidation(operations: RepoReaderConfig["repos"][number]["operations"]): boolean {
  return Boolean(
    operations?.enabled
      && operations.git_stage_enabled
      && operations.git_commit_enabled
      && operations.cleanup_enabled
      && operations.validation_enabled
      && (operations.validation_test_path_globs?.length ?? 0) === 0
  );
}

async function looksLikeGitRepository(root: string): Promise<boolean> {
  try {
    await stat(join(root, ".git"));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function validateLifecycleRepository(
  repo: NonNullable<Awaited<ReturnType<typeof validateConfigDocument>>["config"]>["repos"][number],
  canonicalRoot: string,
  issues: ConfigIssue[]
): Promise<string | undefined> {
  const lifecycle = repo.lifecycle;
  if (!lifecycle) return undefined;

  try {
    const topLevel = (await runGit(canonicalRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(topLevel) !== canonicalRoot) {
      issues.push({ code: "REPO_ROOT_NOT_TOPLEVEL", message: `Lifecycle root is not the exact Git worktree top level for repo_id "${repo.repo_id}".` });
    }
  } catch {
    issues.push({ code: "GIT_BINDING_UNAVAILABLE", message: `Git repository binding could not be read for repo_id "${repo.repo_id}".` });
    return undefined;
  }

  if (lifecycle.kind === "github") {
    try {
      const urls = (await runGit(canonicalRoot, ["remote", "get-url", "--all", lifecycle.remote_name]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (urls.length !== 1) {
        issues.push({ code: "REMOTE_IDENTITY_AMBIGUOUS", message: `Lifecycle remote must resolve to exactly one fetch URL for repo_id "${repo.repo_id}".` });
      } else {
        const configured = normalizeRemoteIdentity(urls[0]!);
        const expected = normalizeRemoteIdentity(lifecycle.expected_remote_identity);
        if (expected !== lifecycle.expected_remote_identity) {
          issues.push({ code: "REMOTE_IDENTITY_NOT_CANONICAL", message: `expected_remote_identity is not canonical for repo_id "${repo.repo_id}".` });
        }
        if (configured !== expected) {
          issues.push({ code: "REMOTE_IDENTITY_MISMATCH", message: `Configured Git remote does not match expected_remote_identity for repo_id "${repo.repo_id}".` });
        }
        const githubRepository = githubRepositoryFromIdentity(configured);
        if (githubRepository && githubRepository.toLowerCase() !== lifecycle.github_repository.toLowerCase()) {
          issues.push({ code: "GITHUB_REPOSITORY_MISMATCH", message: `GitHub repository identity does not match the configured remote for repo_id "${repo.repo_id}".` });
        }
      }
    } catch {
      issues.push({ code: "REMOTE_IDENTITY_UNAVAILABLE", message: `Lifecycle remote identity could not be read safely for repo_id "${repo.repo_id}".` });
    }
  }

  for (const branch of lifecycle.allowed_base_branches) {
    try {
      await runGit(canonicalRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    } catch {
      issues.push({ code: "BASE_BRANCH_MISSING", message: `Allowed base branch "${branch}" is not a local branch for repo_id "${repo.repo_id}".` });
    }
  }

  const worktreeRoot = resolve(lifecycle.worktree_root);
  try {
    const worktreeInfo = await lstat(worktreeRoot);
    if (!worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) {
      issues.push({ code: "WORKTREE_ROOT_UNSAFE", message: `Configured worktree root is not a no-follow directory for repo_id "${repo.repo_id}".` });
      return undefined;
    }
    const canonicalWorktreeRoot = await realpath(worktreeRoot);
    if (pathsOverlap(canonicalRoot, canonicalWorktreeRoot)) {
      issues.push({ code: "WORKTREE_ROOT_OVERLAP", message: `Configured worktree root overlaps the owner repository for repo_id "${repo.repo_id}".` });
    }
    return canonicalWorktreeRoot;
  } catch (error) {
    if (isNotFoundError(error)) {
      issues.push({ code: "WORKTREE_ROOT_MISSING", message: `Configured worktree root does not exist for repo_id "${repo.repo_id}".` });
      return undefined;
    }
    throw error;
  }
}

function validateLifecycleRootSeparation(
  repoRoots: Array<{ repo_id: string; root: string }>,
  worktreeRoots: Array<{ repo_id: string; root: string }>,
  issues: ConfigIssue[]
): void {
  for (const worktree of worktreeRoots) {
    for (const repo of repoRoots) {
      if (worktree.repo_id !== repo.repo_id && pathsOverlap(worktree.root, repo.root)) {
        issues.push({
          code: "WORKTREE_ROOT_CROSSES_REPOSITORY",
          message: `Worktree root for repo_id "${worktree.repo_id}" overlaps owner root for repo_id "${repo.repo_id}".`
        });
      }
    }
  }
  for (let leftIndex = 0; leftIndex < worktreeRoots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < worktreeRoots.length; rightIndex += 1) {
      const left = worktreeRoots[leftIndex]!;
      const right = worktreeRoots[rightIndex]!;
      if (pathsOverlap(left.root, right.root)) {
        issues.push({
          code: "WORKTREE_ROOTS_OVERLAP",
          message: `Worktree roots overlap for repo_id "${left.repo_id}" and "${right.repo_id}".`
        });
      }
    }
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
    maxBuffer: 256 * 1_024,
    encoding: "utf8"
  });
  return stdout;
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.includes(`..${sep}`));
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "config";
  }
  return `config.${path.map((segment) => String(segment)).join(".")}`;
}
