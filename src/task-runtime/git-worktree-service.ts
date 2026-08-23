import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runGitBounded } from "../services/git-exec.js";
import { hashedDiskKey } from "./canonical-json.js";
import { GitObjectIdSchema, TaskIdSchema } from "./contracts.js";
import { TaskRuntimeError } from "./errors.js";
import { hasCode } from "./secure-runtime-fs.js";

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;

export type GitTaskBinding = {
  task_id: string;
  owner_root: string;
  base_branch: string;
  base_commit: string;
  base_tree: string;
  branch_slug: string;
  server_branch: string;
  worktree_path: string;
};

export type WorktreeObservation = {
  disposition: "ABSENT" | "EXACT" | "PARTIAL" | "CONFLICT";
  path_present: boolean;
  registered: boolean;
  branch_present: boolean;
  observed_head: string | null;
  observed_tree: string | null;
  observed_branch: string | null;
};

export type WorktreeStatus = {
  clean: boolean;
  porcelain_z: string;
  changed_entry_count: number;
  head: string;
  tree: string;
  branch: string;
};

type PorcelainWorktree = { path: string; head: string | null; branch: string | null };

export class GitTaskWorktreeService {
  readonly worktreeRoot: string;

  constructor(worktreeRoot: string) {
    if (!isAbsolute(worktreeRoot)) throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "The configured worktree root must be absolute.");
    this.worktreeRoot = resolve(worktreeRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.worktreeRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "The configured worktree root must be a real directory.");
    }
    if ((metadata.mode & 0o777) !== 0o700) await chmod(this.worktreeRoot, 0o700);
  }

  binding(input: {
    task_id: string;
    owner_root: string;
    base_branch: string;
    base_commit: string;
    base_tree: string;
    branch_slug: string;
  }): GitTaskBinding {
    TaskIdSchema.parse(input.task_id);
    GitObjectIdSchema.parse(input.base_commit);
    GitObjectIdSchema.parse(input.base_tree);
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(input.branch_slug)) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "branch_slug is invalid.");
    }
    if (!isAbsolute(input.owner_root) || input.base_branch.startsWith("-") || /[\0\r\n]/.test(input.base_branch)) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "Base repository root or branch is unsafe.");
    }
    const suffix = hashedDiskKey("task-worktree", input.task_id).slice(0, 12);
    const serverBranch = `chat-pro/tasks/${input.branch_slug}-${suffix}`;
    const directoryName = `${input.branch_slug}-${suffix}`;
    const worktreePath = resolve(this.worktreeRoot, directoryName);
    if (!isWithin(this.worktreeRoot, worktreePath)) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "Derived task worktree escaped the configured worktree root.");
    }
    return {
      task_id: input.task_id,
      owner_root: resolve(input.owner_root),
      base_branch: input.base_branch,
      base_commit: input.base_commit,
      base_tree: input.base_tree,
      branch_slug: input.branch_slug,
      server_branch: serverBranch,
      worktree_path: worktreePath
    };
  }

  async verifyBase(binding: GitTaskBinding): Promise<void> {
    await this.verifyRoots(binding);
    await this.git(binding.owner_root, ["check-ref-format", "--branch", binding.base_branch]);
    const branchCommit = (await this.git(binding.owner_root, ["rev-parse", "--verify", `refs/heads/${binding.base_branch}^{commit}`])).trim();
    const exactCommit = (await this.git(binding.owner_root, ["rev-parse", "--verify", `${binding.base_commit}^{commit}`])).trim();
    const exactTree = (await this.git(binding.owner_root, ["rev-parse", "--verify", `${binding.base_commit}^{tree}`])).trim();
    if (branchCommit !== binding.base_commit || exactCommit !== binding.base_commit || exactTree !== binding.base_tree) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Base branch, commit, or tree no longer matches the admitted task binding.", {
        expected_commit: binding.base_commit,
        observed_branch_commit: branchCommit,
        observed_commit: exactCommit,
        expected_tree: binding.base_tree,
        observed_tree: exactTree
      });
    }
  }

  async inspect(binding: GitTaskBinding): Promise<WorktreeObservation> {
    await this.verifyRoots(binding);
    const entries = parseWorktreePorcelain(await this.git(binding.owner_root, ["worktree", "list", "--porcelain", "-z"]));
    const entry = entries.find((candidate) => resolve(candidate.path) === binding.worktree_path);
    const branchHead = await this.readBranchHead(binding.owner_root, binding.server_branch);
    const pathPresent = await pathExists(binding.worktree_path);
    if (!entry && !pathPresent && !branchHead) {
      return emptyObservation("ABSENT");
    }

    if (!entry || !pathPresent || !branchHead) {
      return {
        disposition: "PARTIAL",
        path_present: pathPresent,
        registered: Boolean(entry),
        branch_present: Boolean(branchHead),
        observed_head: entry?.head ?? branchHead,
        observed_tree: null,
        observed_branch: entry?.branch ?? null
      };
    }

    const pathMetadata = await lstat(binding.worktree_path);
    if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
      return {
        disposition: "CONFLICT",
        path_present: true,
        registered: true,
        branch_present: true,
        observed_head: entry.head,
        observed_tree: null,
        observed_branch: entry.branch
      };
    }
    const observedHead = (await this.git(binding.worktree_path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const observedTree = (await this.git(binding.worktree_path, ["rev-parse", "--verify", "HEAD^{tree}"])).trim();
    const observedBranch = (await this.git(binding.worktree_path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    const exact = entry.branch === `refs/heads/${binding.server_branch}`
      && observedBranch === binding.server_branch
      && observedHead === branchHead
      && entry.head === observedHead;
    return {
      disposition: exact ? "EXACT" : "CONFLICT",
      path_present: true,
      registered: true,
      branch_present: true,
      observed_head: observedHead,
      observed_tree: observedTree,
      observed_branch: observedBranch
    };
  }

  private async verifyRoots(binding: GitTaskBinding): Promise<void> {
    this.assertDerivedBinding(binding);
    await this.initialize();
    const worktreeRootReal = await realpath(this.worktreeRoot);
    if (worktreeRootReal !== this.worktreeRoot) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "The configured task worktree root must be canonical and cannot traverse symlinks.");
    }
    const ownerReal = await realpath(binding.owner_root);
    if (ownerReal !== binding.owner_root) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Base repository root must be canonical and cannot be a symlink.");
    }
    if (isWithin(ownerReal, this.worktreeRoot)) {
      throw new TaskRuntimeError("RUNTIME_PATH_UNSAFE", "The configured task worktree root cannot be inside the base repository.");
    }
    const topLevel = (await this.git(binding.owner_root, ["rev-parse", "--show-toplevel"])).trim();
    if (await realpath(topLevel) !== ownerReal) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Base repository lookup did not resolve to the Git worktree top level.");
    }
  }

  private assertDerivedBinding(binding: GitTaskBinding): void {
    const derived = this.binding({
      task_id: binding.task_id,
      owner_root: binding.owner_root,
      base_branch: binding.base_branch,
      base_commit: binding.base_commit,
      base_tree: binding.base_tree,
      branch_slug: binding.branch_slug
    });
    if (
      derived.owner_root !== binding.owner_root
      || derived.server_branch !== binding.server_branch
      || derived.worktree_path !== binding.worktree_path
    ) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Git task binding branch or path was not server-derived.");
    }
  }

  async create(binding: GitTaskBinding): Promise<WorktreeObservation> {
    await this.verifyBase(binding);
    const before = await this.inspect(binding);
    if (before.disposition === "EXACT") return before;
    if (before.disposition !== "ABSENT") throw uncertain(before);
    await this.git(binding.owner_root, [
      "worktree",
      "add",
      "-b",
      binding.server_branch,
      "--",
      binding.worktree_path,
      binding.base_commit
    ]);
    await chmod(binding.worktree_path, 0o700);
    const after = await this.inspect(binding);
    if (after.disposition !== "EXACT" || after.observed_head !== binding.base_commit || after.observed_tree !== binding.base_tree) {
      throw uncertain(after);
    }
    return after;
  }

  async status(binding: GitTaskBinding): Promise<WorktreeStatus> {
    const observation = await this.inspect(binding);
    if (observation.disposition !== "EXACT") throw uncertain(observation);
    const porcelain = await this.git(binding.worktree_path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    return {
      clean: porcelain.length === 0,
      porcelain_z: porcelain,
      changed_entry_count: porcelain.length === 0 ? 0 : porcelain.split("\0").filter(Boolean).length,
      head: observation.observed_head!,
      tree: observation.observed_tree!,
      branch: observation.observed_branch!
    };
  }

  async remove(binding: GitTaskBinding): Promise<"ABSENT" | "REMOVED"> {
    const observation = await this.inspect(binding);
    if (observation.disposition === "ABSENT") return "ABSENT";
    if (observation.disposition !== "EXACT") throw uncertain(observation);
    const status = await this.status(binding);
    if (!status.clean) {
      throw new TaskRuntimeError("GIT_WORKTREE_DIRTY", "Task cleanup preserves a dirty worktree.", {
        changed_entry_count: status.changed_entry_count
      });
    }
    await this.git(binding.owner_root, ["worktree", "remove", "--", binding.worktree_path]);
    const after = await this.inspect(binding);
    if (after.path_present || after.registered) throw uncertain(after);
    return "REMOVED";
  }

  async safeDeleteBranch(binding: GitTaskBinding, expectedHead: string): Promise<{ deleted: boolean; reason: "ABSENT" | "DELETED" | "NOT_MERGED" }> {
    GitObjectIdSchema.parse(expectedHead);
    await this.verifyRoots(binding);
    const entries = parseWorktreePorcelain(await this.git(binding.owner_root, ["worktree", "list", "--porcelain", "-z"]));
    if (entries.some((entry) => entry.branch === `refs/heads/${binding.server_branch}`)) {
      throw new TaskRuntimeError("GIT_WORKTREE_CONFLICT", "The server-owned branch is still checked out and cannot be deleted.");
    }
    const branchHead = await this.readBranchHead(binding.owner_root, binding.server_branch);
    if (!branchHead) return { deleted: false, reason: "ABSENT" };
    if (branchHead !== expectedHead) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Server-owned branch head changed before safe deletion.", {
        expected_head: expectedHead,
        observed_head: branchHead
      });
    }
    try {
      await this.git(binding.owner_root, ["branch", "-d", "--", binding.server_branch]);
    } catch (error) {
      const stillPresent = await this.readBranchHead(binding.owner_root, binding.server_branch);
      if (stillPresent === expectedHead) return { deleted: false, reason: "NOT_MERGED" };
      throw error;
    }
    if (await this.readBranchHead(binding.owner_root, binding.server_branch)) {
      throw new TaskRuntimeError("GIT_EFFECT_UNCERTAIN", "Git reported branch deletion success but the branch remains present.");
    }
    return { deleted: true, reason: "DELETED" };
  }

  private async readBranchHead(ownerRoot: string, branch: string): Promise<string | null> {
    const output = await this.git(ownerRoot, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]);
    const values = output.split("\n").map((value) => value.trim()).filter(Boolean);
    if (values.length > 1) throw new TaskRuntimeError("GIT_WORKTREE_CONFLICT", "Server-owned branch lookup was ambiguous.");
    return values[0] ?? null;
  }

  private async git(root: string, args: string[]): Promise<string> {
    const result = await runGitBounded({ root, args, max_stdout_bytes: MAX_GIT_OUTPUT });
    return result.stdout;
  }
}

function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const tokens = output.split("\0");
  const result: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | undefined;
  for (const token of tokens) {
    if (token === "") {
      if (current) result.push(current);
      current = undefined;
    } else if (token.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: token.slice("worktree ".length), head: null, branch: null };
    } else if (current && token.startsWith("HEAD ")) {
      current.head = token.slice("HEAD ".length);
    } else if (current && token.startsWith("branch ")) {
      current.branch = token.slice("branch ".length);
    }
  }
  if (current) result.push(current);
  return result;
}

function emptyObservation(disposition: "ABSENT"): WorktreeObservation {
  return {
    disposition,
    path_present: false,
    registered: false,
    branch_present: false,
    observed_head: null,
    observed_tree: null,
    observed_branch: null
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function uncertain(observation: WorktreeObservation): TaskRuntimeError {
  const code = observation.disposition === "CONFLICT" ? "GIT_WORKTREE_CONFLICT" : "GIT_EFFECT_UNCERTAIN";
  return new TaskRuntimeError(code, "Task worktree state is partial, conflicting, or cannot be safely replayed.", observation);
}

function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !value.includes(`..${sep}`));
}
