import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RepoConfigSchema, type ParsedProjectRootConfig, type ParsedRepoConfig } from "./schema.js";

const execFileAsync = promisify(execFile);

export type DiscoveredWorktreeConfig = ParsedRepoConfig & { discovery_base_repo_id: string };

// Git's own worktree registry supplies candidates. Never scan arbitrary parent
// directories or admit an unverified .git indirection file.
export async function discoverLinkedWorktrees(
  bases: ParsedRepoConfig[],
  projectRoots: ParsedProjectRootConfig[],
  targetRoot?: string
): Promise<DiscoveredWorktreeConfig[]> {
  const exclusions = await Promise.all(projectRoots.map(async (project) => ({
    ...project, root: await realpath(project.root)
  })));
  const roots = new Set(bases.map((repo) => repo.root));
  const ids = new Set(bases.map((repo) => repo.repo_id));
  const commonDirs = new Set<string>();
  const discovered: DiscoveredWorktreeConfig[] = [];

  for (const base of bases) {
    if (base.allow_non_git) continue;
    let common: string;
    let candidates: string[];
    try {
      await assertDirectory(base.root);
      const dotGit = await lstat(join(base.root, ".git"));
      if (dotGit.isSymbolicLink() || (!dotGit.isDirectory() && !dotGit.isFile())) continue;
      if (await gitPath(base.root, "--show-toplevel") !== base.root) continue;
      common = await gitPath(base.root, "--git-common-dir");
      await assertDirectory(common);
      if (commonDirs.has(common)) continue;
      candidates = parseWorktreePaths(await runGit(base.root, ["worktree", "list", "--porcelain", "-z"]));
      commonDirs.add(common);
    } catch {
      // Unavailable owners cannot authorize discovery. In particular, do not
      // retain entries from an earlier successful scan.
      continue;
    }

    for (const root of candidates) {
      if ((targetRoot !== undefined && root !== targetRoot) || roots.has(root) || exclusions.some((project) => {
        const directChild = relative(project.root, root).split(sep)[0] ?? "";
        return project.exclude_directories.some((name) => name.normalize("NFC").toLowerCase() === directChild.normalize("NFC").toLowerCase());
      })) continue;
      try {
        await assertDirectory(root);
        const dotGitPath = join(root, ".git");
        const indirection = await readRegularFile(dotGitPath);
        if (!indirection.startsWith("gitdir: ")) continue;
        const gitDir = resolve(root, stripFinalNewline(indirection.slice(8)));
        await assertDirectory(gitDir);
        if (dirname(gitDir) !== join(common, "worktrees")) continue;
        const backlink = stripFinalNewline(await readRegularFile(join(gitDir, "gitdir")));
        if (!isAbsolute(backlink) || backlink !== dotGitPath) continue;
        const commonLink = stripFinalNewline(await readRegularFile(join(gitDir, "commondir")));
        if (resolve(gitDir, commonLink) !== common) continue;
        if (await gitPath(root, "--show-toplevel") !== root) continue;
        if (await gitPath(root, "--git-common-dir") !== common) continue;

        const digest = createHash("sha256").update(JSON.stringify([common, root])).digest("hex").slice(0, 20);
        const name = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "checkout";
        const repoId = `${base.repo_id.slice(0, 100)}--worktree-${name}-${digest}`;
        if (ids.has(repoId)) continue;
        discovered.push({ ...RepoConfigSchema.parse({
          repo_id: repoId,
          display_name: `${base.display_name} / ${basename(root)} (worktree, read-only)`,
          root,
          writes: { enabled: false },
          operations: { enabled: false }
        }), discovery_base_repo_id: base.repo_id });
        roots.add(root);
        ids.add(repoId);
      } catch {
        // Removed, prunable, symlinked, or rebound checkouts are not admitted.
      }
    }
  }
  return discovered;
}

function parseWorktreePaths(output: string): string[] {
  return output.split("\0\0").flatMap((record) => {
    const fields = record.split("\0");
    const first = fields[0];
    if (!first?.startsWith("worktree ") || fields.some((field) => field === "bare" || field.startsWith("prunable"))) return [];
    const path = first.slice(9);
    return isAbsolute(path) ? [path] : [];
  });
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("Worktree discovery requires a canonical no-follow directory.");
  }
}

async function readRegularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) {
    throw new Error("Worktree metadata must be a bounded regular file.");
  }
  return readFile(path, "utf8");
}

async function gitPath(root: string, option: string): Promise<string> {
  return stripFinalNewline(await runGit(root, ["rev-parse", "--path-format=absolute", option]));
}

function stripFinalNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", GIT_OPTIONAL_LOCKS: "0" },
    timeout: 10_000,
    maxBuffer: 1_024 * 1_024,
    encoding: "utf8"
  });
  return stdout;
}
