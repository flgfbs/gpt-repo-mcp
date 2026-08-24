import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { z } from "zod";
import {
  RepoReaderConfigSchema,
  type ParsedRepoConfig
} from "../config/schema.js";
import { expandProjectRepositories } from "../config/project-root-discovery.js";
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

  private constructor(
    repos: RuntimeRepoConfig[],
    readonly limits: {
      max_files: number;
      max_bytes_per_file: number;
      max_total_bytes: number;
    },
    readonly codeIntelligence: z.output<typeof RepoReaderConfigSchema>["code_intelligence"],
    readonly runtimeRoot: string
  ) {
    this.reposById = new Map(repos.map((repo) => [repo.repo_id, repo]));
    this.baseRepoIds = new Set(repos.map((repo) => repo.repo_id));
  }

  static async fromConfig(config: RepoReaderConfigInput): Promise<RootRegistry> {
    const parsed = RepoReaderConfigSchema.parse(config);
    const repos: RuntimeRepoConfig[] = await expandProjectRepositories(parsed);
    return new RootRegistry(repos, {
      max_files: parsed.limits.max_files ?? DEFAULT_LIMITS.max_files,
      max_bytes_per_file: parsed.limits.max_bytes_per_file ?? DEFAULT_LIMITS.max_bytes_per_file,
      max_total_bytes: parsed.limits.max_total_bytes ?? DEFAULT_LIMITS.max_total_bytes
    }, parsed.code_intelligence, resolve(parsed.runtime_root));
  }

  static async fromFile(configPath: string): Promise<RootRegistry> {
    const raw = await readFile(configPath, "utf8");
    return RootRegistry.fromConfig(JSON.parse(raw));
  }

  list(): Array<Pick<RuntimeRepoConfig, "repo_id" | "display_name" | "root">> {
    return [...this.baseRepoIds].map((repoId) => {
      const repo = this.reposById.get(repoId)!;
      return {
        repo_id: repo.repo_id,
        display_name: repo.display_name,
        root: repo.root
      };
    });
  }

  listTaskRepos(): TaskRepoBinding[] {
    return [...this.reposById.values()]
      .flatMap((repo) => repo.task ? [repo.task] : [])
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  }

  get(repoId: string): RuntimeRepoConfig {
    const repo = this.reposById.get(repoId);
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
  if (authority === "inspect") {
    return {
      ...base.operations,
      enabled: false,
      git_stage_enabled: false,
      git_commit_enabled: false,
      validation_enabled: false,
      cleanup_enabled: false
    };
  }
  if (authority === "implement") {
    return {
      ...base.operations,
      git_stage_enabled: false,
      git_commit_enabled: false,
      validation_enabled: false
    };
  }
  return base.operations;
}

function sameTaskBinding(left: TaskRepoBinding, right: TaskRepoBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.includes(`..${sep}`));
}
