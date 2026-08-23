import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createLifecycleRuntimeBundle } from "../src/services/lifecycle-factory.js";
import { RootRegistry } from "../src/services/root-registry.js";
import { attachValidationArtifactCapture } from "../src/services/validation-artifact-capture.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable task mutation runtime", () => {
  test("binds exact state, persists only digests, and never invokes a completed operation twice", async () => {
    const fixture = await setup();
    let contacts = 0;
    const sourcePayload = "unique source payload that must not enter mutation state";
    const input = {
      repo_id: fixture.taskRepoId,
      operation_id: "operation-task-mutation",
      expected_head_sha: fixture.head,
      expected_tree_sha: fixture.tree,
      path: "change.txt",
      content: sourcePayload
    };
    const first = await fixture.bundle.taskMutations.run("repo_write_file", input, async () => {
      contacts += 1;
      await writeFile(join(fixture.worktree, "change.txt"), `${sourcePayload}\n`);
      await git(fixture.worktree, "add", "--", "change.txt");
      await git(fixture.worktree, "commit", "-m", "Task mutation fixture");
      return {
        structuredContent: { ok: true, changed: true },
        content: [{ type: "text", text: "Changed one fixture file." }]
      };
    });
    expect(first.isError).not.toBe(true);
    expect(contacts).toBe(1);

    const replay = await fixture.bundle.taskMutations.run("repo_write_file", input, async () => {
      contacts += 1;
      throw new Error("must not run");
    });
    expect(replay).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TASK_OPERATION_ALREADY_COMPLETED" } }
    });
    expect(contacts).toBe(1);

    const mutationFiles = await readdir(join(fixture.runtimeRoot, "mutations"));
    expect(mutationFiles).toHaveLength(1);
    const stored = await readFile(join(fixture.runtimeRoot, "mutations", mutationFiles[0]!), "utf8");
    expect(stored).not.toContain(sourcePayload);
    expect(JSON.parse(stored)).toMatchObject({
      phase: "LOCAL_MUTATION_COMPLETE",
      operation_id: "operation-task-mutation",
      tool: "repo_write_file",
      before_head_sha: fixture.head,
      result_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  test("blocks stale, conflicting, and interrupted mutations without replay", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.worktree, "commit.txt"), "commit\n");
    await git(fixture.worktree, "add", "--", "commit.txt");
    await git(fixture.worktree, "commit", "-m", "Advance task head");

    let staleInvocations = 0;
    const stale = await fixture.bundle.taskMutations.run("repo_write_file", {
      repo_id: fixture.taskRepoId,
      operation_id: "operation-stale-mutation",
      expected_head_sha: fixture.head,
      expected_tree_sha: fixture.tree,
      path: "stale.txt"
    }, async () => {
      staleInvocations += 1;
      return { content: [{ type: "text", text: "unexpected" }] };
    });
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: "TASK_OPERATION_BLOCKED" } } });
    expect(staleInvocations).toBe(0);

    const currentHead = await git(fixture.worktree, "rev-parse", "HEAD");
    const currentTree = await git(fixture.worktree, "rev-parse", "HEAD^{tree}");
    let interruptedInvocations = 0;
    const interruptedInput = {
      repo_id: fixture.taskRepoId,
      operation_id: "operation-interrupted-mutation",
      expected_head_sha: currentHead,
      expected_tree_sha: currentTree,
      path: "partial.txt"
    };
    const interrupted = await fixture.bundle.taskMutations.run("repo_write_file", interruptedInput, async () => {
      interruptedInvocations += 1;
      await writeFile(join(fixture.worktree, "partial.txt"), "preserve for exact recovery\n");
      throw new Error("simulated interruption");
    });
    expect(interrupted).toMatchObject({ isError: true, structuredContent: { error: { code: "TASK_OPERATION_BLOCKED" } } });
    expect(await readFile(join(fixture.worktree, "partial.txt"), "utf8")).toBe("preserve for exact recovery\n");
    await fixture.bundle.taskMutations.run("repo_write_file", interruptedInput, async () => {
      interruptedInvocations += 1;
      return { content: [{ type: "text", text: "unexpected replay" }] };
    });
    expect(interruptedInvocations).toBe(1);

    const conflict = await fixture.bundle.taskMutations.run("repo_write_changes", {
      ...interruptedInput,
      path: "different.txt"
    }, async () => ({ content: [{ type: "text", text: "unexpected conflict invocation" }] }));
    expect(conflict).toMatchObject({ isError: true, structuredContent: { error: { code: "TASK_OPERATION_CONFLICT" } } });
  });

  test("stores complete validation output as an opaque task artifact bound to exact Git state", async () => {
    const fixture = await setup();
    const fullOutput = `full-output-${"x".repeat(8_000)}`;
    const structuredContent = attachValidationArtifactCapture({
      ok: true,
      repo_id: fixture.taskRepoId,
      validation_id: "validation-full-log",
      profile: "all",
      dry_run: false,
      status: "passed",
      commands: [],
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      warnings: [],
      validation_artifact: { path: ".chatgpt/validation/validation-full-log/result.json" }
    }, {
      schema_version: 1,
      validation_id: "validation-full-log",
      repo_id: fixture.taskRepoId,
      profile: "all",
      status: "passed",
      commands: [{
        profile: "all",
        script: "verify",
        command: "make verify",
        status: "passed",
        exit_code: 0,
        timed_out: false,
        duration_ms: 10,
        stdout: fullOutput,
        stderr: ""
      }]
    });
    const result = await fixture.bundle.taskMutations.run("repo_validate", {
      repo_id: fixture.taskRepoId,
      operation_id: "operation-validation-artifact",
      expected_head_sha: fixture.head,
      expected_tree_sha: fixture.tree,
      profile: "all"
    }, async () => ({
      structuredContent,
      content: [{ type: "text", text: "Validation passed." }]
    }));

    expect(result.isError).not.toBe(true);
    const reference = (result.structuredContent as { validation_artifact: { artifact_id: string; path?: string } }).validation_artifact;
    expect(reference.artifact_id).toMatch(/^artifact_/);
    expect(reference.path).toBeUndefined();
    const stored = await fixture.bundle.artifacts.read({
      task_id: "task-mutation",
      artifact_id: reference.artifact_id,
      offset: 0,
      length: 65_536
    });
    const payload = JSON.parse(Buffer.from(stored.content_base64, "base64").toString("utf8"));
    expect(payload).toMatchObject({
      operation_id: "operation-validation-artifact",
      expected_head_sha: fixture.head,
      expected_tree_sha: fixture.tree,
      resulting_head_sha: fixture.head,
      resulting_tree_sha: fixture.tree
    });
    expect(payload.validation.commands[0].stdout).toBe(fullOutput);
  });
});

async function setup() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "task-mutation-runtime-")));
  roots.push(parent);
  const ownerRoot = join(parent, "owner");
  const worktreeRoot = join(parent, "worktrees");
  const runtimeRoot = join(parent, "runtime");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Mutation Test");
  await git(ownerRoot, "config", "user.email", "mutation@example.com");
  await writeFile(join(ownerRoot, "README.md"), "# Mutation fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const head = await git(ownerRoot, "rev-parse", "HEAD");
  const tree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "owner",
      display_name: "Owner",
      root: ownerRoot,
      lifecycle: {
        authority: "ship",
        remote_name: "origin",
        expected_remote_identity: "https://github.com/example/fixture.git",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        github_repository: "example/fixture",
        merge_method: "squash"
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const opened = await bundle.lifecycle.taskOpen({
    operation_id: "operation-open-mutation",
    repo_id: "owner",
    task_id: "task-mutation",
    base_branch: "main",
    base_commit_sha: head,
    base_tree_sha: tree,
    authority: "ship",
    goal: "Exercise durable inherited task mutation guards.",
    branch_slug: "mutation"
  });
  const worktree = registry.get(opened.task.repo_id).root;
  return { parent, ownerRoot, worktreeRoot, runtimeRoot, head, tree, registry, bundle, taskRepoId: opened.task.repo_id, worktree };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
