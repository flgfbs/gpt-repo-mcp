import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runChatProRepoCli, type OwnerCliDependencies } from "../src/cli/chat-pro-repo.js";
import type { OwnerCliIo } from "../src/cli/cli-types.js";
import type {
  OwnerApprovalCliStore,
  OwnerMergeApprovalView,
  OwnerMergeGateView
} from "../src/cli/owner-approval.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";
import { TaskStateStore } from "../src/task-runtime/state-store.js";
import type { TaskState } from "../src/task-runtime/contracts.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("chat-pro-repo owner CLI", () => {
  test("advertises exactly the required owner command families", async () => {
    const fixture = await cliFixture();
    const result = await fixture.run(["--help"]);

    expect(result.code).toBe(0);
    for (const command of [
      "config validate",
      "repo add",
      "repo list",
      "repo remove",
      "project-root add",
      "project-root list",
      "project-root remove",
      "task list",
      "task inspect",
      "approve-merge --gate-id",
      "approval inspect",
      "doctor",
      "server start"
    ]) expect(result.stdout).toContain(command);
    expect(result.stderr).toBe("");
  });

  test("adds one project root and lists its direct Git repositories", async () => {
    const fixture = await cliFixture();
    const projects = join(fixture.root, "Projects");
    await mkdir(projects);
    await initializeRepository(join(projects, "alpha"), "origin", "https://github.com/acme/alpha.git");
    await initializeRepository(join(projects, "beta"), "origin", "https://github.com/acme/beta.git");

    const added = await fixture.run([
      "project-root", "add", projects,
      "--id", "projects",
      "--exclude", "CodexWorktrees"
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("approved_repository_count=2");
    expect(added.stdout).toContain("restart_required=true");

    const validated = await fixture.run(["config", "validate"]);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain("PASS 2 repository(s) validated.");
    expect(validated.stdout).toContain("DISCOVERY explicit=0 discovered=2");

    const listed = await fixture.run(["repo", "list"]);
    expect(listed.stdout).toContain("alpha\talpha\tread");
    expect(listed.stdout).toContain("beta\tbeta\tread");

    const projectRoots = await fixture.run(["project-root", "list"]);
    expect(projectRoots.stdout).toContain(`projects\tread\t-\tCodexWorktrees\t${await realpath(projects)}`);

    const removed = await fixture.run(["project-root", "remove", "projects"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("repository_data_deleted=false");
  });

  test("lists explicit entries for diagnosis when a registered root is missing", async () => {
    const fixture = await cliFixture();
    const missingRoot = join(fixture.root, "deleted-repository");
    await writeFile(fixture.configPath, `${JSON.stringify({
      repos: [{ repo_id: "deleted", display_name: "Deleted Repository", root: missingRoot }],
      limits: {},
      runtime_root: fixture.runtimeRoot
    })}\n`, { mode: 0o600 });

    const listed = await fixture.run(["repo", "list"]);

    expect(listed.code).toBe(1);
    expect(listed.stdout).toContain(`deleted\tDeleted Repository\tread\t-\t-\t${missingRoot}`);
    expect(listed.stderr).toContain("explicit entries are listed for diagnosis");
    expect(listed.stderr).toContain("[ROOT_MISSING]");
    expect(listed.stderr).not.toContain("CLI_FAILED");
  });

  test("adds, validates, lists, and removes a complete lifecycle repository policy", async () => {
    const fixture = await cliFixture();
    const repository = join(fixture.root, "repository");
    const worktrees = join(fixture.root, "task-worktrees");
    await initializeRepository(repository, "upstream", "git@github.com:acme/demo.git");

    const added = await fixture.run([
      "repo", "add", repository,
      "--id", "demo",
      "--name", "Demo Repository",
      "--mode", "ship",
      "--remote-name", "upstream",
      "--expected-remote-identity", "github.com/acme/demo",
      "--base", "main",
      "--worktree-root", worktrees,
      "--github-repository", "acme/demo",
      "--merge-method", "rebase",
      "--required-check", "test",
      "--required-check", "lint",
      "--max-concurrent-tasks", "3",
      "--keep-worktree",
      "--keep-local-branch"
    ]);

    expect(added.code).toBe(0);
    expect(added.stdout).toContain("expected_remote_identity=github.com/acme/demo");
    expect(added.stdout).not.toContain("git@github.com");
    const document = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      repos: Array<{
        root: string;
        operations: { validation_profiles?: unknown };
        lifecycle: Record<string, unknown>;
      }>;
    };
    expect(document.repos[0]).toMatchObject({
      root: await realpath(repository),
      operations: { validation_profiles: {} },
      lifecycle: {
        authority: "ship",
        remote_name: "upstream",
        expected_remote_identity: "github.com/acme/demo",
        allowed_base_branches: ["main"],
        worktree_root: await realpath(worktrees),
        github_repository: "acme/demo",
        merge_method: "rebase",
        required_checks: ["test", "lint"],
        require_clean_base: true,
        max_concurrent_tasks: 3,
        cleanup: {
          remove_worktree: false,
          delete_local_branch: false,
          require_terminal_task: true
        }
      }
    });
    expect((await stat(fixture.configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(worktrees)).mode & 0o777).toBe(0o700);

    const validated = await fixture.run(["config", "validate"]);
    expect(validated).toMatchObject({ code: 0 });
    expect(validated.stdout).toContain("PASS 1 repository(s) validated.");

    const listed = await fixture.run(["repo", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("demo\tDemo Repository\tship\tacme/demo\tmain");

    const removed = await fixture.run(["repo", "remove", "demo"]);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("repository_data_deleted=false");
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toMatchObject({ repos: [] });
  });

  test("reads bounded durable tasks and refuses repository removal until cleanup is complete", async () => {
    const fixture = await cliFixture();
    const task = await writeOpenTask(fixture.runtimeRoot);
    await writeFile(fixture.configPath, `${JSON.stringify({
      repos: [{ repo_id: "owner", display_name: "Owner", root: fixture.root }],
      limits: {},
      runtime_root: fixture.runtimeRoot
    })}\n`, { mode: 0o600 });
    await chmod(fixture.configPath, 0o600);

    const listed = await fixture.run(["task", "list", "--limit", "10"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`${task.task_id}\t${task.repo_id}\towner\tship\tOPEN`);

    const inspected = await fixture.run(["task", "inspect", task.task_id]);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      task: { task_id: task.task_id, lifecycle: "OPEN", state_sha256: task.state_sha256 },
      operations: []
    });

    const refused = await fixture.run(["repo", "remove", "owner"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("ACTIVE_TASKS_PRESENT");
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toMatchObject({
      repos: [{ repo_id: "owner" }]
    });
  });

  test("shows the exact merge binding and creates approval only after exact confirmation", async () => {
    const fixture = await cliFixture();
    const digest = "a".repeat(64);
    const gateId = `merge_manifest_${digest}`;
    const gate: OwnerMergeGateView = {
      gate_id: gateId,
      gate_sha256: digest,
      repository_id: "repository-node-id",
      repository: "acme/demo",
      repo_id: "task-repo",
      task_id: "task-1",
      pull_request_number: 42,
      pull_request_state: "OPEN",
      pull_request_draft: true,
      pull_request_mergeable: "MERGEABLE",
      base_branch: "main",
      base_sha: "b".repeat(40),
      task_branch: "chat-pro/tasks/change-123456789abc",
      head_sha: "c".repeat(40),
      tree_sha: "d".repeat(40),
      merge_method: "squash",
      required_checks: [{ name: "test", status: "success" }],
      unresolved_review_threads: 0,
      material_findings: 0,
      unknown_external_effects: 0,
      risks: ["The approval expires with this exact gate."],
      prepared_at: "2026-08-23T01:00:00.000Z",
      expires_at: "2026-08-23T01:15:00.000Z"
    };
    const approval: OwnerMergeApprovalView = {
      approval_id: `merge_approval_${"X".repeat(24)}`,
      gate_id: gateId,
      gate_sha256: digest,
      issued_at: "2026-08-23T01:01:00.000Z",
      expires_at: "2026-08-23T01:10:00.000Z",
      consumed: false
    };
    const store: OwnerApprovalCliStore = {
      resolveGate: vi.fn(async () => gate),
      createApproval: vi.fn(async () => approval),
      inspectApproval: vi.fn(async () => approval)
    };

    const declined = await fixture.run(
      ["approve-merge", "--gate-id", gateId],
      { approvals: store, now: () => new Date("2026-08-23T01:02:00.000Z") },
      "not approved"
    );
    expect(declined.code).toBe(1);
    expect(declined.stdout).toContain("repository=acme/demo");
    expect(declined.stdout).toContain(`head_sha=${"c".repeat(40)}`);
    expect(declined.stdout).toContain("- test: success");
    expect(store.createApproval).not.toHaveBeenCalled();

    const approved = await fixture.run(
      ["approve-merge", "--gate-id", gateId],
      { approvals: store, now: () => new Date("2026-08-23T01:02:00.000Z") },
      "APPROVE"
    );
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain(`approval_id=${approval.approval_id}`);
    expect(store.createApproval).toHaveBeenCalledWith({ gateId, gateSha256: digest });

    const inspected = await fixture.run([
      "approval", "inspect",
      "--approval-id", approval.approval_id,
      "--gate-id", gateId
    ], { approvals: store });
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toEqual(approval);
  });

  test("loads the durable approval adapter by default and fails closed for an unknown gate", async () => {
    const fixture = await cliFixture();
    const result = await fixture.run(["approve-merge", "--gate-id", `merge_manifest_${"a".repeat(64)}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("GATE_NOT_FOUND");
  });

  test("starts only the fixed loopback endpoint after deterministic config validation", async () => {
    const fixture = await cliFixture();
    const startServer = vi.fn(async () => undefined);
    const result = await fixture.run(["server", "start"], { startServer });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("starting=http://127.0.0.1:8789/mcp");
    expect(startServer).toHaveBeenCalledWith({
      configPath: fixture.configPath,
      host: "127.0.0.1",
      port: 8789
    });
  });
});

async function cliFixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-pro-owner-cli-"));
  roots.push(root);
  const configPath = join(root, "config.local.json");
  const runtimeRoot = join(root, "runtime");
  await writeFile(configPath, `${JSON.stringify({ repos: [], limits: {}, runtime_root: runtimeRoot })}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return {
    root,
    configPath,
    runtimeRoot,
    run: async (args: string[], dependencies: OwnerCliDependencies = {}, confirmation = "") => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: OwnerCliIo = {
        cwd: root,
        env: {},
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        confirm: async () => confirmation
      };
      const code = await runChatProRepoCli([...args, "--config", configPath], io, dependencies);
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    }
  };
}

async function initializeRepository(root: string, remoteName: string, remoteUrl: string): Promise<void> {
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "CLI Fixture");
  await git(root, "config", "user.email", "cli-fixture@example.invalid");
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await git(root, "add", "--", "README.md");
  await git(root, "commit", "-m", "Initial fixture");
  await git(root, "remote", "add", remoteName, remoteUrl);
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    timeout: 10_000,
    maxBuffer: 256 * 1024
  });
}

async function writeOpenTask(runtimeRoot: string): Promise<TaskState> {
  const fs = new SecureRuntimeFs(runtimeRoot);
  const store = new TaskStateStore(fs);
  await store.initialize();
  const timestamp = "2026-08-23T01:00:00.000Z";
  return store.writeTask({
    schema_version: 1,
    task_id: "task-active",
    repo_id: `task-${"a".repeat(40)}`,
    base_repo_id: "owner",
    base_branch: "main",
    base_commit: "b".repeat(40),
    base_tree: "c".repeat(40),
    authority: "ship",
    goal: "Exercise owner CLI durable task inspection.",
    branch_slug: "active",
    server_branch: `chat-pro/tasks/active-${"d".repeat(12)}`,
    worktree_path: join(runtimeRoot, "worktrees", "active"),
    lifecycle: "OPEN",
    worktree_state: "PRESENT",
    branch_state: "PRESENT",
    worktree_head: "b".repeat(40),
    worktree_tree: "c".repeat(40),
    registration_state: "REGISTERED",
    close_disposition: null,
    closed_at: null,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp
  });
}
