import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";
import { createMcpServer } from "../src/register.js";
import { RootRegistry } from "../src/services/root-registry.js";
import type { TaskMutationRuntime } from "../src/services/task-mutation-runtime.js";
import type { ToolName } from "../src/tools/contracts.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task-aware delegation handler", () => {
  test("keeps task mutation bindings at the durable guard boundary and out of the strict delegation service input", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chat-pro-task-aware-delegation-"));
    roots.push(sandbox);
    const baseRoot = join(sandbox, "base");
    const worktreeRoot = join(sandbox, "worktrees");
    const taskRoot = join(worktreeRoot, "task");
    await mkdir(baseRoot);
    await mkdir(taskRoot, { recursive: true });
    await git(taskRoot, "init", "-b", "main");
    await git(taskRoot, "config", "user.name", "Task Delegation Test");
    await git(taskRoot, "config", "user.email", "task-delegation@example.invalid");
    await writeFile(join(taskRoot, "README.md"), "# Task delegation fixture\n");
    await git(taskRoot, "add", "--", "README.md");
    await git(taskRoot, "commit", "-m", "Initial fixture");
    const head = await git(taskRoot, "rev-parse", "HEAD");
    const tree = await git(taskRoot, "rev-parse", "HEAD^{tree}");

    const registry = await RootRegistry.fromConfig({
      repos: [{
        repo_id: "base",
        display_name: "Base",
        root: baseRoot,
        writes: { enabled: true, allowed_globs: ["**"], denied_globs: [] },
        operations: { enabled: true },
        lifecycle: {
          kind: "local",
          authority: "write",
          allowed_base_branches: ["main"],
          worktree_root: worktreeRoot
        }
      }],
      limits: {}
    });
    await registry.registerTaskRepo({
      task_id: "task-delegation",
      task_repo_id: "task-repo-delegation",
      base_repo_id: "base",
      authority: "implement",
      branch: "chat-pro/tasks/task-delegation",
      worktree: taskRoot
    });

    const guard = new RecordingTaskMutationRuntime();
    const server = createMcpServer({ registry, taskMutations: guard });
    const client = new Client({ name: "task-aware-delegation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "repo_write_codex_task",
        arguments: {
          repo_id: "task-repo-delegation",
          operation_id: "operation-task-delegation",
          expected_head_sha: head,
          expected_tree_sha: tree,
          run_id: "2026-08-26T000000Z-task-aware-delegation",
          title: "Exercise task-aware delegation",
          task_kind: "technical_infrastructure",
          assignment: "Validate task-aware Delegation v3 without writing task artifacts.",
          outcome: {
            beneficiary: "Repository operator",
            current_problem: "Task mutation bindings previously leaked into the strict delegation service schema.",
            desired_outcome: "The durable guard retains exact task bindings while the service receives only delegation fields.",
            why_now: "Task-scoped queued delegation must work through the public MCP tool."
          },
          technical_context: {
            enabling_value: "Restore task-scoped Delegation v3 writes without weakening the strict service contract."
          },
          starting_points: ["README.md"],
          authorization_scope: ["README.md"],
          forbidden_paths: [],
          hard_constraints: ["Do not write artifacts during this dry run."],
          must_preserve: ["The durable task mutation guard receives the exact operation, HEAD, and tree."],
          explicit_exclusions: ["Do not contact an external runner."],
          technical_acceptance_criteria: ["The dry-run result validates through the MCP handler."],
          runner: { mode: "manual" },
          dry_run: true,
          reason: "Exercise task-aware handler input separation."
        }
      });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        ok: true,
        repo_id: "task-repo-delegation",
        run_id: "2026-08-26T000000Z-task-aware-delegation",
        dry_run: true,
        written_paths: []
      });
      expect(guard.tools).toEqual(["repo_write_codex_task"]);
      expect(guard.inputs[0]).toMatchObject({
        operation_id: "operation-task-delegation",
        expected_head_sha: head,
        expected_tree_sha: tree
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

class RecordingTaskMutationRuntime implements TaskMutationRuntime {
  readonly tools: ToolName[] = [];
  readonly inputs: Record<string, unknown>[] = [];

  async run(
    tool: ToolName,
    input: Record<string, unknown>,
    invoke: () => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    this.tools.push(tool);
    this.inputs.push(input);
    return invoke();
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
