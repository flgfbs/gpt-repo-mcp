import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TaskArtifactStore } from "../src/task-runtime/artifact-store.js";
import { canonicalSha256 } from "../src/task-runtime/canonical-json.js";
import type { OperationState, TaskOpenInput } from "../src/task-runtime/contracts.js";
import {
  SemanticWorkerReceiptSchema,
  SemanticWorkerTaskSchema,
  semanticWorkerReceiptSha256,
  semanticWorkerTaskSha256
} from "../src/task-runtime/semantic-worker-contracts.js";
import { GitTaskWorktreeService } from "../src/task-runtime/git-worktree-service.js";
import {
  TaskRuntimeService,
  type BaseRepositoryLookup,
  type TaskRepositoryRegistration,
  type TaskRepositoryRegistrar
} from "../src/task-runtime/task-service.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task runtime lifecycle with real Git worktrees", () => {
  test("opens a server-owned local branch, returns an ephemeral repo id, and rehydrates after restart", async () => {
    const fixture = await gitFixture();
    const firstRegistrar = new MemoryRegistrar();
    const first = service(fixture, firstRegistrar);
    const input = openInput(fixture, "task-restart", "operation-open");
    const opened = await first.open(input);
    expect(opened.repo_id).toMatch(/^task-[a-f0-9]{40}$/);
    expect(opened.task.server_branch).toMatch(/^chat-pro\/tasks\/restart-[a-f0-9]{12}$/);
    expect(opened.task.worktree_path.startsWith(`${fixture.worktreeRoot}/`)).toBe(true);
    expect(opened.task.worktree_path).not.toContain(".chatgpt");
    expect((await lstat(opened.task.worktree_path)).mode & 0o777).toBe(0o700);
    expect(await git(opened.task.worktree_path, "symbolic-ref", "--short", "HEAD")).toBe(opened.task.server_branch);
    const worktrees = new GitTaskWorktreeService(fixture.worktreeRoot);
    const binding = worktrees.binding({
      task_id: input.task_id,
      owner_root: fixture.ownerRoot,
      base_branch: input.base_branch,
      base_commit: input.base_commit,
      base_tree: input.base_tree,
      branch_slug: input.branch_slug
    });
    await expect(worktrees.safeDeleteBranch({ ...binding, server_branch: "main" }, fixture.commit))
      .rejects.toMatchObject({ code: "GIT_BINDING_MISMATCH" });
    expect(await git(fixture.ownerRoot, "rev-parse", "main")).toBe(fixture.commit);
    expect(firstRegistrar.registrations.get(opened.repo_id)).toMatchObject({
      root: opened.task.worktree_path,
      authority: "implement",
      base_repo_id: "owner"
    });

    const restartedRegistrar = new MemoryRegistrar();
    const restarted = service(fixture, restartedRegistrar);
    expect((await restarted.listTasks()).map((task) => task.task_id)).toEqual([input.task_id]);
    const rehydrated = await restarted.rehydrateOpenTaskRepositories();
    expect(rehydrated.registered).toEqual([firstRegistrar.registrations.get(opened.repo_id)]);
    expect(restartedRegistrar.registrations.has(opened.repo_id)).toBe(true);
    const readBack = await restarted.open(input);
    expect(readBack.repo_id).toBe(opened.repo_id);
    expect(readBack.operation.phase).toBe("LOCAL_MUTATION_COMPLETE");
    expect(readBack.recovered_from_readback).toBe(true);
    expect(restartedRegistrar.registrations.has(opened.repo_id)).toBe(true);
    expect((await restarted.status(input.task_id)).observed_worktree.disposition).toBe("EXACT");
  });

  test("quarantines a damaged open task while rehydrating unaffected task repositories", async () => {
    const fixture = await gitFixture();
    const runtime = service(fixture, new MemoryRegistrar());
    const damaged = await runtime.open(openInput(fixture, "task-damaged", "operation-open-damaged"));
    const healthy = await runtime.open(openInput(fixture, "task-healthy", "operation-open-healthy"));
    await rm(damaged.task.worktree_path, { recursive: true, force: false });

    const registrar = new MemoryRegistrar();
    const restarted = service(fixture, registrar);
    const rehydrated = await restarted.rehydrateOpenTaskRepositories();
    expect(rehydrated.registered).toEqual([expect.objectContaining({ task_id: "task-healthy" })]);
    expect(rehydrated.recovery_required_task_ids).toEqual(["task-damaged"]);
    expect(registrar.registrations.has(healthy.repo_id)).toBe(true);
    expect(registrar.registrations.has(damaged.repo_id)).toBe(false);
    expect((await restarted.status("task-damaged"))).toMatchObject({
      task: { lifecycle: "RECOVERY_REQUIRED", registration_state: "UNKNOWN" },
      observed_worktree: { disposition: "PARTIAL" },
      git_status: null
    });
  });

  test("starts with a missing base registration and rehydrates the recovery task after configuration repair", async () => {
    const fixture = await gitFixture();
    const opened = await service(fixture, new MemoryRegistrar())
      .open(openInput(fixture, "task-base-repair", "operation-open-base-repair"));
    const unavailable = new TaskRuntimeService({
      runtimeRoot: fixture.runtimeRoot,
      baseRepositories: { async getBaseRepository() { throw new Error("base repository is not configured"); } },
      registrar: new MemoryRegistrar(),
      lock: { timeoutMs: 5_000, pollMs: 5 }
    });

    expect(await unavailable.rehydrateOpenTaskRepositories()).toMatchObject({
      registered: [],
      recovery_required_task_ids: ["task-base-repair"]
    });
    expect(await unavailable.status("task-base-repair")).toMatchObject({
      repo_id: opened.repo_id,
      task: { lifecycle: "RECOVERY_REQUIRED", registration_state: "UNKNOWN" },
      observed_worktree: { disposition: "UNKNOWN" },
      git_status: null
    });

    const repairedRegistrar = new MemoryRegistrar();
    const repaired = service(fixture, repairedRegistrar);
    expect(await repaired.rehydrateOpenTaskRepositories()).toMatchObject({
      registered: [expect.objectContaining({ task_id: "task-base-repair" })],
      recovery_required_task_ids: []
    });
    expect((await repaired.status("task-base-repair")).task).toMatchObject({
      lifecycle: "OPEN",
      worktree_state: "PRESENT",
      branch_state: "PRESENT",
      registration_state: "REGISTERED"
    });
    expect(repairedRegistrar.registrations.has(opened.repo_id)).toBe(true);
  });

  test("serializes concurrent opens and rejects operation-id conflicts", async () => {
    const fixture = await gitFixture();
    const registrar = new MemoryRegistrar();
    const first = service(fixture, registrar);
    const second = service(fixture, registrar);
    const input = openInput(fixture, "task-concurrent", "operation-concurrent");
    const [left, right] = await Promise.all([first.open(input), second.open(input)]);
    expect(left.repo_id).toBe(right.repo_id);
    expect(await git(fixture.ownerRoot, "for-each-ref", "--format=%(refname)", `refs/heads/${left.task.server_branch}`))
      .toBe(`refs/heads/${left.task.server_branch}`);
    await expect(first.open({ ...input, goal: "A conflicting canonical request." }))
      .rejects.toMatchObject({ code: "OPERATION_ID_CONFLICT" });
  });

  test("reconciles LOCAL_MUTATION_STARTED after restart but never replays UNKNOWN_AFTER_CONTACT", async () => {
    const fixture = await gitFixture();
    const registrar = new MemoryRegistrar();
    const recoverable = service(fixture, registrar);
    await recoverable.initialize();
    const recoverInput = openInput(fixture, "task-recoverable", "operation-recoverable");
    await writeOperationLineage(recoverable, recoverInput, ["ADMITTED", "LOCAL_MUTATION_STARTED"], "ABSENT");
    const recovered = await recoverable.open(recoverInput);
    expect(recovered.recovered_from_readback).toBe(true);
    expect(recovered.operation.phase).toBe("LOCAL_MUTATION_COMPLETE");

    const blocked = service(fixture, registrar);
    await blocked.initialize();
    const blockedInput = openInput(fixture, "task-unknown", "operation-unknown");
    await writeOperationLineage(blocked, blockedInput, ["ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "UNKNOWN_AFTER_CONTACT"], "UNKNOWN");
    const binding = new GitTaskWorktreeService(fixture.worktreeRoot).binding({
      task_id: blockedInput.task_id,
      owner_root: fixture.ownerRoot,
      base_branch: blockedInput.base_branch,
      base_commit: blockedInput.base_commit,
      base_tree: blockedInput.base_tree,
      branch_slug: blockedInput.branch_slug
    });
    await expect(blocked.open(blockedInput)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
    await expect(lstat(binding.worktree_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(fixture.ownerRoot, "for-each-ref", "--format=%(refname)", `refs/heads/${binding.server_branch}`)).toBe("");

    const partial = service(fixture, registrar);
    await partial.initialize();
    const partialInput = openInput(fixture, "task-partial", "operation-partial");
    await writeOperationLineage(partial, partialInput, ["ADMITTED", "LOCAL_MUTATION_STARTED"], "ABSENT");
    const partialBinding = new GitTaskWorktreeService(fixture.worktreeRoot).binding({
      task_id: partialInput.task_id,
      owner_root: fixture.ownerRoot,
      base_branch: partialInput.base_branch,
      base_commit: partialInput.base_commit,
      base_tree: partialInput.base_tree,
      branch_slug: partialInput.branch_slug
    });
    await git(fixture.ownerRoot, "branch", partialBinding.server_branch, fixture.commit);
    await expect(partial.open(partialInput)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
    await expect(lstat(partialBinding.worktree_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await partial.states.readOperation(partialInput.task_id, partialInput.operation_id)).toMatchObject({
      phase: "BLOCKED",
      effect_state: "PARTIAL"
    });
    expect((await partial.listTasks()).map((task) => task.task_id)).toEqual(["task-partial", "task-recoverable"]);
  });

  test("preserves dirty cleanup targets and does not replay the blocked cleanup", async () => {
    const fixture = await gitFixture();
    const runtime = service(fixture, new MemoryRegistrar());
    const input = openInput(fixture, "task-dirty", "operation-open-dirty");
    const opened = await runtime.open(input);
    await runtime.close({ task_id: input.task_id, operation_id: "operation-close-dirty", disposition: "blocked" });
    const localFile = join(opened.task.worktree_path, "untracked.txt");
    await writeFile(localFile, "preserve me\n");
    expect((await runtime.status(input.task_id)).git_status).toMatchObject({ clean: false, changed_entry_count: 1 });
    const cleanup = { task_id: input.task_id, operation_id: "operation-cleanup-dirty" };
    await expect(runtime.cleanup(cleanup)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
    expect(await readFile(localFile, "utf8")).toBe("preserve me\n");
    await expect(runtime.cleanup(cleanup)).rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
    expect(await git(opened.task.worktree_path, "symbolic-ref", "--short", "HEAD")).toBe(opened.task.server_branch);
  });

  test("cleans a closed worktree safely while preserving durable artifacts", async () => {
    const fixture = await gitFixture();
    const registrar = new MemoryRegistrar();
    const runtime = service(fixture, registrar);
    const input = openInput(fixture, "task-clean", "operation-open-clean");
    const opened = await runtime.open(input);
    const artifacts = new TaskArtifactStore(runtime.states, runtime.locks, { maxArtifactBytes: 1024, maxRangeBytes: 128 });
    const artifact = await artifacts.put({
      task_id: input.task_id,
      kind: "operation_receipt",
      media_type: "application/json",
      logical_path: "receipts/final.json",
      content: '{"outcome":"completed"}'
    });
    const closed = await runtime.close({
      task_id: input.task_id,
      operation_id: "operation-close-clean",
      disposition: "completed",
      reason: "The semantic task completed."
    });
    expect(closed.task.close_disposition).toBe("completed");
    expect(closed.task.close_reason).toBe("The semantic task completed.");
    const repeatedOpen = await runtime.open(input);
    expect(repeatedOpen.task.lifecycle).toBe("CLOSED");
    expect(repeatedOpen.task.close_disposition).toBe("completed");
    expect(registrar.registrations.size).toBe(0);
    await expect(runtime.open({ ...input, operation_id: "operation-reopen-clean" }))
      .rejects.toMatchObject({ code: "OPERATION_BLOCKED" });
    const restarted = service(fixture, new MemoryRegistrar());
    expect((await restarted.status(input.task_id)).task.close_disposition).toBe("completed");
    await expect(restarted.close({
      task_id: input.task_id,
      operation_id: "operation-close-conflict",
      disposition: "superseded"
    })).rejects.toMatchObject({ code: "TASK_BINDING_CONFLICT" });
    const cleaned = await runtime.cleanup({ task_id: input.task_id, operation_id: "operation-cleanup-clean" });
    expect(cleaned.task.lifecycle).toBe("CLEANED");
    expect(cleaned.task.worktree_state).toBe("ABSENT");
    await expect(lstat(opened.task.worktree_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(fixture.ownerRoot, "for-each-ref", "--format=%(refname)", `refs/heads/${opened.task.server_branch}`)).toBe("");
    const preserved = await artifacts.read({ task_id: input.task_id, artifact_id: artifact.artifact_id });
    expect(Buffer.from(preserved.content_base64, "base64").toString("utf8")).toBe('{"outcome":"completed"}');
    const repeatedCleanup = await runtime.cleanup({ task_id: input.task_id, operation_id: "operation-cleanup-clean-second" });
    expect(repeatedCleanup.task.close_disposition).toBe("completed");
    expect(repeatedCleanup.operation.phase).toBe("LOCAL_MUTATION_COMPLETE");
  });

  test("removes a clean worktree but preserves an unmerged server-owned branch", async () => {
    const fixture = await gitFixture();
    const runtime = service(fixture, new MemoryRegistrar());
    const input = openInput(fixture, "task-unmerged", "operation-open-unmerged");
    const opened = await runtime.open(input);
    await writeFile(join(opened.task.worktree_path, "change.txt"), "task commit\n");
    await git(opened.task.worktree_path, "add", "--", "change.txt");
    await git(opened.task.worktree_path, "commit", "-m", "Task-only commit");
    const taskHead = await git(opened.task.worktree_path, "rev-parse", "HEAD");
    await runtime.close({ task_id: input.task_id, operation_id: "operation-close-unmerged", disposition: "completed" });
    const cleaned = await runtime.cleanup({ task_id: input.task_id, operation_id: "operation-cleanup-unmerged" });
    expect(cleaned).toMatchObject({ branch_deleted: false, branch_preserved: true });
    expect(cleaned.task).toMatchObject({ lifecycle: "CLEANED", branch_state: "PRESERVED", close_disposition: "completed" });
    expect(await git(fixture.ownerRoot, "rev-parse", `refs/heads/${opened.task.server_branch}`)).toBe(taskHead);
    await expect(lstat(opened.task.worktree_path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("provider-neutral Semantic Worker contracts", () => {
  test("accepts stable task and receipt data without provider fields and rejects provider-specific extensions", () => {
    const task = {
      schema_version: 1 as const,
      task_id: "task-contract",
      repo_id: `task-${"a".repeat(40)}`,
      authority: "implement" as const,
      goal: "Make a bounded change.",
      base: { repo_id: "owner", branch: "main", commit: "1".repeat(40), tree: "2".repeat(40) },
      constraints: ["Preserve unrelated files."],
      acceptance_criteria: ["Focused tests pass."],
      writable_paths: ["src/example.ts"],
      created_at: new Date().toISOString(),
      task_sha256: "0".repeat(64)
    };
    task.task_sha256 = semanticWorkerTaskSha256(task);
    expect(SemanticWorkerTaskSchema.parse(task)).toEqual(task);
    expect(() => SemanticWorkerTaskSchema.parse({ ...task, provider: "specific-model" })).toThrow();
    const receipt = {
      schema_version: 1 as const,
      task_id: task.task_id,
      repo_id: task.repo_id,
      outcome: "completed" as const,
      summary: "Completed the bounded task.",
      head_before: "1".repeat(40),
      head_after: "4".repeat(40),
      edits: [],
      validations: [],
      evidence: [],
      completed_at: new Date().toISOString(),
      receipt_sha256: "0".repeat(64)
    };
    receipt.receipt_sha256 = semanticWorkerReceiptSha256(receipt);
    expect(SemanticWorkerReceiptSchema.parse(receipt)).toEqual(receipt);
  });
});

class MemoryRegistrar implements TaskRepositoryRegistrar {
  readonly registrations = new Map<string, TaskRepositoryRegistration>();

  async registerTaskRepository(registration: TaskRepositoryRegistration): Promise<void> {
    const existing = this.registrations.get(registration.repo_id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(registration)) throw new Error("registration conflict");
    this.registrations.set(registration.repo_id, registration);
  }

  async unregisterTaskRepository(repoId: string): Promise<void> {
    this.registrations.delete(repoId);
  }
}

type GitFixture = {
  parent: string;
  ownerRoot: string;
  runtimeRoot: string;
  worktreeRoot: string;
  commit: string;
  tree: string;
  lookup: BaseRepositoryLookup;
};

async function gitFixture(): Promise<GitFixture> {
  const created = await mkdtemp(join(tmpdir(), "task-runtime-git-"));
  const parent = await realpath(created);
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const runtimeRoot = join(parent, "runtime");
  const worktreeRoot = join(parent, "worktrees");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Task Runtime Test");
  await git(ownerRoot, "config", "user.email", "test@example.com");
  await writeFile(join(ownerRoot, "README.md"), "# Fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const commit = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const lookup: BaseRepositoryLookup = {
    async getBaseRepository(repoId) {
      if (repoId !== "owner") throw new Error("unknown repository");
      return { repo_id: repoId, root: ownerRoot, worktree_root: worktreeRoot };
    }
  };
  return { parent, ownerRoot, runtimeRoot, worktreeRoot, commit, tree, lookup };
}

function service(fixture: GitFixture, registrar: TaskRepositoryRegistrar): TaskRuntimeService {
  return new TaskRuntimeService({
    runtimeRoot: fixture.runtimeRoot,
    baseRepositories: fixture.lookup,
    registrar,
    lock: { timeoutMs: 5_000, pollMs: 5 }
  });
}

function openInput(fixture: GitFixture, taskId: string, operationId: string): TaskOpenInput {
  return {
    task_id: taskId,
    operation_id: operationId,
    base_repo_id: "owner",
    base_branch: "main",
    base_commit: fixture.commit,
    base_tree: fixture.tree,
    authority: "implement",
    goal: "Implement a bounded fixture change.",
    branch_slug: taskId.replace(/^task-/, "").slice(0, 40)
  };
}

async function writeOperationLineage(
  runtime: TaskRuntimeService,
  input: TaskOpenInput,
  phases: OperationState["phase"][],
  finalEffect: OperationState["effect_state"]
): Promise<void> {
  const timestamp = new Date().toISOString();
  let operation = await runtime.states.writeOperation({
    schema_version: 1,
    task_id: input.task_id,
    operation_id: input.operation_id,
    kind: "OPEN",
    request_sha256: canonicalSha256({ schema_version: 1, kind: "OPEN", request: input }),
    phase: "CREATED",
    effect_state: "NOT_STARTED",
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
    result_repo_id: null,
    error_code: null,
    error_message: null
  });
  for (const [index, phase] of phases.entries()) {
    operation = await runtime.states.writeOperation({
      ...operation,
      phase,
      effect_state: phase === "EXTERNAL_CONTACTED"
        ? "UNKNOWN"
        : index === phases.length - 1
          ? finalEffect
          : operation.effect_state,
      revision: operation.revision + 1,
      updated_at: new Date().toISOString(),
      completed_at: phase === "UNKNOWN_AFTER_CONTACT" ? new Date().toISOString() : null
    });
  }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
