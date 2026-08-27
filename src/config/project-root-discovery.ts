import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  RepoConfigSchema,
  type ParsedProjectRootConfig,
  type ParsedRepoConfig,
  type ParsedRepoReaderConfig
} from "./schema.js";
import { isNotFoundError } from "../runtime/fs-helpers.js";

const execFileAsync = promisify(execFile);

export class ProjectRootDiscoveryError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectRootDiscoveryError";
  }
}

export async function expandProjectRepositories(
  config: ParsedRepoReaderConfig
): Promise<ParsedRepoConfig[]> {
  try {
    return await expandProjectRepositoriesUnchecked(config);
  } catch (error) {
    if (error instanceof ProjectRootDiscoveryError) throw error;
    throw new ProjectRootDiscoveryError(
      "PROJECT_DISCOVERY_FAILED",
      "Project repository discovery failed unexpectedly.",
      { cause: error }
    );
  }
}

async function expandProjectRepositoriesUnchecked(
  config: ParsedRepoReaderConfig
): Promise<ParsedRepoConfig[]> {
  const repos: ParsedRepoConfig[] = [];
  const rootsByCanonicalPath = new Map<string, string>();
  const idsByRepoId = new Map<string, string>();
  const explicitRepoRoots: Array<{ repo_id: string; root: string }> = [];

  for (const repo of config.repos) {
    const canonicalRoot = await realpath(resolve(repo.root));
    repos.push({ ...repo, root: canonicalRoot });
    rootsByCanonicalPath.set(canonicalRoot, repo.repo_id);
    idsByRepoId.set(repo.repo_id, canonicalRoot);
    explicitRepoRoots.push({ repo_id: repo.repo_id, root: canonicalRoot });
  }

  const projectRootIds = new Set<string>();
  const canonicalProjectRoots: Array<{ project_root_id: string; root: string }> = [];
  for (const projectRoot of config.project_roots) {
    if (projectRootIds.has(projectRoot.project_root_id)) {
      throw new ProjectRootDiscoveryError(
        "DUPLICATE_PROJECT_ROOT_ID",
        `Duplicate project_root_id "${projectRoot.project_root_id}".`
      );
    }
    projectRootIds.add(projectRoot.project_root_id);

    const canonicalRoot = await canonicalProjectRoot(projectRoot);
    const explicitContainer = explicitRepoRoots.find((entry) => isWithin(entry.root, canonicalRoot));
    if (explicitContainer) {
      throw new ProjectRootDiscoveryError(
        "PROJECT_ROOT_INSIDE_EXPLICIT_REPO",
        `Project root "${projectRoot.project_root_id}" is equal to or nested inside explicit repository "${explicitContainer.repo_id}".`
      );
    }
    const overlap = canonicalProjectRoots.find((entry) => pathsOverlap(entry.root, canonicalRoot));
    if (overlap) {
      throw new ProjectRootDiscoveryError(
        "PROJECT_ROOT_OVERLAP",
        `Project roots overlap: "${overlap.project_root_id}" and "${projectRoot.project_root_id}".`
      );
    }
    canonicalProjectRoots.push({ project_root_id: projectRoot.project_root_id, root: canonicalRoot });

    const excluded = new Set(projectRoot.exclude_directories.map(normalizeDirectoryName));
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || excluded.has(normalizeDirectoryName(entry.name))) continue;
      const candidateInput = join(canonicalRoot, entry.name);
      const candidateStats = await lstat(candidateInput);
      if (candidateStats.isSymbolicLink()) continue;
      const candidateRoot = await realpath(candidateInput);
      if (!isWithin(canonicalRoot, candidateRoot)) {
        throw new ProjectRootDiscoveryError(
          "PROJECT_REPOSITORY_ESCAPE",
          `Discovered repository escapes project root "${projectRoot.project_root_id}": ${entry.name}`
        );
      }
      if (!await isExactGitRoot(candidateRoot, projectRoot.project_root_id)) continue;

      // An explicit repository entry is an owner override for the same canonical root.
      if (rootsByCanonicalPath.has(candidateRoot)) continue;

      const repoId = discoveredRepoId(projectRoot.repo_id_prefix, entry.name);
      const existingIdRoot = idsByRepoId.get(repoId);
      if (existingIdRoot) {
        throw new ProjectRootDiscoveryError(
          "PROJECT_REPO_ID_COLLISION",
          `Discovered repo_id "${repoId}" maps to both ${existingIdRoot} and ${candidateRoot}. Configure repo_id_prefix or exclude one directory.`
        );
      }

      const repo = RepoConfigSchema.parse({
        repo_id: repoId,
        display_name: entry.name,
        root: candidateRoot,
        writes: { enabled: false },
        operations: { enabled: false }
      });
      repos.push(repo);
      rootsByCanonicalPath.set(candidateRoot, repoId);
      idsByRepoId.set(repoId, candidateRoot);
    }
  }

  return repos;
}

async function canonicalProjectRoot(projectRoot: ParsedProjectRootConfig): Promise<string> {
  const configuredRoot = resolve(projectRoot.root);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(configuredRoot);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new ProjectRootDiscoveryError(
        "PROJECT_ROOT_MISSING",
        `Project root does not exist for "${projectRoot.project_root_id}": ${projectRoot.root}`
      );
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ProjectRootDiscoveryError(
      "PROJECT_ROOT_UNSAFE",
      `Project root must be a real directory for "${projectRoot.project_root_id}": ${projectRoot.root}`
    );
  }
  return realpath(configuredRoot);
}

async function isExactGitRoot(root: string, projectRootId: string): Promise<boolean> {
  let dotGit: Awaited<ReturnType<typeof lstat>>;
  try {
    dotGit = await lstat(join(root, ".git"));
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
  // Linked worktrees and submodules use a regular .git indirection file. They
  // are intentionally excluded from automatic Project-root admission.
  if (dotGit.isFile()) return false;
  if (dotGit.isSymbolicLink() || !dotGit.isDirectory()) {
    throw new ProjectRootDiscoveryError(
      "PROJECT_REPOSITORY_UNSAFE",
      `Unsafe .git entry under project root "${projectRootId}": ${root}`
    );
  }

  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeout: 10_000,
      maxBuffer: 256 * 1_024,
      encoding: "utf8"
    });
    return await realpath(stdout.trim()) === root;
  } catch (error) {
    if (error instanceof ProjectRootDiscoveryError) throw error;
    throw new ProjectRootDiscoveryError(
      "PROJECT_REPOSITORY_INVALID",
      `Git binding is invalid under project root "${projectRootId}": ${root}`
    );
  }
}

function normalizeRepoId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function hashedRepoId(value: string): string {
  return `repo-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function discoveredRepoId(prefix: string | undefined, directoryName: string): string {
  const leafId = normalizeRepoId(directoryName) || hashedRepoId(directoryName);
  const repoId = prefix ? `${prefix}-${leafId}` : leafId;
  if (repoId.length > 200) {
    throw new ProjectRootDiscoveryError(
      "PROJECT_REPO_ID_TOO_LONG",
      `Discovered repo_id for directory "${directoryName}" exceeds 200 characters. Configure a shorter repo_id_prefix.`
    );
  }
  return repoId;
}

function normalizeDirectoryName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}
