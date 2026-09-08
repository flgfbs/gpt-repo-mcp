import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  RepoReaderConfigSchema,
  type ParsedRepoConfig,
  type ParsedRepoReaderConfig
} from "../config/schema.js";
import { expandProjectRepositories, ProjectRootDiscoveryError } from "../config/project-root-discovery.js";
import { discoverLinkedWorktrees, type DiscoveredWorktreeConfig } from "../config/linked-worktree-discovery.js";
import { DEFAULT_LIMITS } from "../policies/limits.js";
import { RepoReaderError } from "../runtime/errors.js";

export type TaskRepoBinding = {
  task_id: string;
  task_repo_id: string;
  base_repo_id: string;
  authority: "inspect" | "implement" | "ship";
  branch: string;
  worktree: string;
};

export type RuntimeRepoConfig = ParsedRepoConfig & {
  task?: TaskRepoBinding;
};
export type RepoConfig = Omit<RuntimeRepoConfig, "writes" | "operations"> & {
  writes?: RuntimeRepoConfig["writes"];
  operations?: RuntimeRepoConfig["operations"];
};

type RepoReaderConfigInput = z.input<typeof RepoReaderConfigSchema>;

export class RootRegistry {
  private readonly reposById: Map<string, RuntimeRepoConfig>;
  private readonly baseRepoIds: Set<string>;
  private discoveredWorktrees = new Map<string, DiscoveredWorktreeConfig>();
  private discoveryRefresh?: Promise<void>;
  private lastDiscoveryAt = 0;
  private warnings: string[] = [];

  private constructor(
    repos: RuntimeRepoConfig[],
    readonly limits: {
      max_files: number;
      max_bytes_per_file: number;
      max_total_bytes: number;
    },
    readonly codeIntelligence: z.output<typeof RepoReaderConfigSchema>["code_intelligence"],
    readonly runtimeRoot: string,
    private readonly discoveryConfig: ParsedRepoReaderConfig
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.repo_id, repo]));
    this.baseRepoIds = new Set(repos.map((repo) => repo.repo_id));
  }

  static async fromConfig(config: RepoReaderConfigInput): Promise<RootRegistry> {
    const parsed = RepoReaderConfigSchema.parse(config);
    const repos: RuntimeRepoConfig[] = await expandProjectRepositories(parsed);
    const discoveryConfig = {
      ...parsed,
      repos: parsed.repos.map((repo) => ({ ...repo, root: repos.find((entry) => entry.repo_id === repo.repo_id)!.root })),
      project_roots: await Promise.all(parsed.project_roots.map(async (project) => ({ ...project, root: await realpath(project.root) })))
    };
    return new RootRegistry(repos, {
      max_files: parsed.limits.max_files ?? DEFAULT_LIMITS.max_files,
      max_bytes_per_file: parsed.limits.max_bytes_per_file ?? DEFAULT_LIMITS.max_bytes_per_file,
      max_total_bytes: parsed.limits.max_total_bytes ?? DEFAULT_LIMITS.max_total_bytes
    }, parsed.code_intelligence, resolve(parsed.runtime_root), discoveryConfig);
  }

  static async fromFile(configPath: string): Promise<RootRegistry> {
    const raw = await readFile(configPath, "utf8");
    return RootRegistry.fromConfig(JSON.parse(raw));
  }

  list(): Array<Pick<RuntimeRepoConfig, "repo_id" | "display_name" | "root">> {
    return [
      ...[...this.baseRepoIds].map((repoId) => this.reposById.get(repoId)!),
      ...this.discoveredWorktrees.values()
    ].map((repo) => {
      return {
        repo_id: repo.repo_id,
        display_name: repo.display_name,
        root: repo.root
      };
    });
  }

  async refreshDiscovery(): Promise<void> {
    if (this.discoveryRefresh) return this.discoveryRefresh;
    const refresh = this.refreshDiscoveryUnchecked();
    this.discoveryRefresh = refresh;
    try {
      await refresh;
    } finally {
      this.lastDiscoveryAt = Date.now();
      this.discoveryRefresh = undefined;
    }
  }

  private async refreshDiscoveryUnchecked(): Promise<void> {
    // Drop old automatic entries even when an owner disappears or discovery
    // fails. Persistent config and server-owned task registrations are separate.
    this.discoveredWorktrees = new Map();
    this.warnings = [];
    const bases = await this.refreshBaseSources();
    const taskRoots = this.listTaskRepos().map((task) => task.worktree);
    const worktrees = await discoverLinkedWorktrees(bases, this.discoveryConfig.project_roots, undefined, [
      ...bases.map((repo) => repo.root), ...taskRoots
    ]);
    for (const repoId of this.baseRepoIds) this.reposById.delete(repoId);
    this.baseRepoIds.clear();
    for (const base of bases) {
      this.reposById.set(base.repo_id, base);
      this.baseRepoIds.add(base.repo_id);
    }
    const registeredRoots = new Set([...this.reposById.values()].map((repo) => repo.root));
    this.discoveredWorktrees = new Map(worktrees
      .filter((repo) => !registeredRoots.has(repo.root) && !this.reposById.has(repo.repo_id))
      .map((repo) => [repo.repo_id, repo]));
  }

  discoveryWarnings(): string[] {
    return [...this.warnings];
  }

  private async refreshBaseSources(): Promise<ParsedRepoConfig[]> {
    const explicit: ParsedRepoConfig[] = [];
    const warn = (source: string, error: unknown) => this.warnings.push(
      `${source}: ${error instanceof ProjectRootDiscoveryError ? error.code : "DISCOVERY_SOURCE_UNAVAILABLE"}`
    );
    for (const repo of this.discoveryConfig.repos) {
      try {
        if (await realpath(repo.root) !== repo.root) throw new Error("Configured root changed.");
        explicit.push(...await expandProjectRepositories({ ...this.discoveryConfig, repos: [repo], project_roots: [] }));
      } catch (error) {
        warn(`repository ${repo.repo_id}`, error);
      }
    }
    const explicitRoots = new Set(explicit.map((repo) => repo.root));
    const discovered = new Map<string, ParsedRepoConfig>();
    const blockedIds = new Set(this.listTaskRepos().map((task) => task.task_repo_id));
    for (const project of this.discoveryConfig.project_roots) {
      try {
        if (await realpath(project.root) !== project.root) throw new Error("Configured project root changed.");
        const entries = await expandProjectRepositories({ ...this.discoveryConfig, repos: explicit, project_roots: [project] });
        for (const entry of entries) {
          if (explicitRoots.has(entry.root)) continue;
          const previous = discovered.get(entry.repo_id);
          if (blockedIds.has(entry.repo_id) || (previous && previous.root !== entry.root)) {
            discovered.delete(entry.repo_id);
            blockedIds.add(entry.repo_id);
            this.warnings.push(`project ${project.project_root_id}: PROJECT_REPO_ID_COLLISION`);
          } else {
            discovered.set(entry.repo_id, entry);
          }
        }
      } catch (error) {
        warn(`project ${project.project_root_id}`, error);
      }
    }
    return [...explicit, ...discovered.values()];
  }

  async refreshForRepo(repoId: string): Promise<void> {
    if (this.reposById.has(repoId)) return;
    if (this.discoveryRefresh) await this.discoveryRefresh;
    const discovered = this.discoveredWorktrees.get(repoId);
    if (!discovered) {
      // Lists explicitly refresh. Typoed ids never launch Git, and repeated
      // stale automatic ids cannot trigger a full rescan on every request.
      if (/--worktree-[a-z0-9-]+-[0-9a-f]{20}$/.test(repoId) && Date.now() - this.lastDiscoveryAt >= 2_000) {
        await this.refreshDiscovery();
      }
      return;
    }
    const owner = this.reposById.get(discovered.discovery_base_repo_id);
    try {
      const current = owner ? await discoverLinkedWorktrees([owner], this.discoveryConfig.project_roots, discovered.root,
        [...this.reposById.values()].map((repo) => repo.root)) : [];
      if (!current.some((repo) => repo.repo_id === repoId && repo.root === discovered.root)) {
        this.discoveredWorktrees.delete(repoId);
      }
    } catch (error) {
      this.discoveredWorktrees.delete(repoId);
      throw error;
    }
  }

  listTaskRepos(): TaskRepoBinding[] {
    return [...this.reposById.values()]
      .flatMap((repo) => repo.task ? [repo.task] : [])
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  get(repoId: string): RuntimeRepoConfig {
    const repo = this.reposById.get(repoId) ?? this.discoveredWorktrees.get(repoId);
    if (!repo) {
      throw new RepoReaderError("UNKNOWN_REPO", `Unknown repo_id: ${repoId}`);
    }
    return repo;
  }

  getBase(repoId: string): RuntimeRepoConfig {
    const repo = this.get(repoId);
    if (repo.task || !this.baseRepoIds.has(repoId)) {
      throw new RepoReaderError("UNKNOWN_REPO", `repo_id is not an owner-registered base repository: ${repoId}`);
    }
    return repo;
  }

  taskBinding(repoId: string): TaskRepoBinding | undefined {
    return this.reposById.get(repoId)?.task;
  }

  async registerTaskRepo(input: TaskRepoBinding): Promise<RuntimeRepoConfig> {
    const base = this.getBase(input.base_repo_id);
    const existing = this.reposById.get(input.task_repo_id);
    if (existing) {
      if (existing.task && sameTaskBinding(existing.task, input)) {
        return existing;
      }
      throw new RepoReaderError("VALIDATION_ERROR", `Task repo_id already exists with different bindings: ${input.task_repo_id}`);
    }
    if (!base.lifecycle) {
      throw new RepoReaderError("VALIDATION_ERROR", `Repository ${base.repo_id} has no lifecycle policy.`);
    }

    const [canonicalWorktreeRoot, canonicalTaskRoot] = await Promise.all([
      realpath(base.lifecycle.worktree_root),
      realpath(input.worktree)
    ]);
    if (!isWithin(canonicalWorktreeRoot, canonicalTaskRoot)) {
      throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", "Task worktree is outside the configured worktree root.");
    }

    const task: TaskRepoBinding = { ...input, worktree: canonicalTaskRoot };
    const repo: RuntimeRepoConfig = {
      ...base,
      repo_id: input.task_repo_id,
      display_name: `${base.display_name} task ${input.task_id}`,
      root: canonicalTaskRoot,
      writes: effectiveWrites(base, input.authority),
      operations: effectiveOperations(base, input.authority),
      task
    };
    this.reposById.set(repo.repo_id, repo);
    for (const [repoId, discovered] of this.discoveredWorktrees) {
      if (discovered.root === repo.root) this.discoveredWorktrees.delete(repoId);
    }
    return repo;
  }

  unregisterTaskRepo(taskRepoId: string): void {
    const repo = this.reposById.get(taskRepoId);
    if (!repo?.task) {
      throw new RepoReaderError("UNKNOWN_REPO", `Unknown task repo_id: ${taskRepoId}`);
    }
    this.reposById.delete(taskRepoId);
  }
}

function effectiveWrites(base: RuntimeRepoConfig, authority: TaskRepoBinding["authority"]): RuntimeRepoConfig["writes"] {
  if (authority === "inspect") {
    return { ...base.writes, enabled: false };
  }
  return base.writes;
}

function effectiveOperations(base: RuntimeRepoConfig, authority: TaskRepoBinding["authority"]): RuntimeRepoConfig["operations"] {
  const taskOperations = base.lifecycle?.kind === "local"
    ? base.lifecycle.task_operations
    : undefined;
  const configured = taskOperations ?? base.operations;
  if (authority === "inspect") {
    return {
      ...configured,
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      validation_enabled: false,
      codex_run_finalize_enabled: false,
      cleanup_enabled: false
    };
  }
  if (authority === "implement") {
    return {
      ...configured,
      git_stage_enabled: false,
      git_commit_enabled: false,
      codex_run_finalize_enabled: false,
      ...(taskOperations ? { cleanup_enabled: false } : {})
    };
  }
  return configured;
}

function sameTaskBinding(left: TaskRepoBinding, right: TaskRepoBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.includes(`..${sep}`));
}
