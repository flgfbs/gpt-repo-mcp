import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "vitest";
import { createMcpServer } from "../src/register.js";
import { RootRegistry } from "../src/services/root-registry.js";
import type { TaskMutationRuntime } from "../src/services/task-mutation-runtime.js";
import type { ToolName } from "../src/tools/contracts.js";

describe("task mutation registration boundary", () => {
  test("routes only inherited task mutations through the durable guard seam", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chat-pro-task-registration-"));
    const baseRoot = join(sandbox, "base");
    const worktreeRoot = join(sandbox, "worktrees");
    const taskRoot = join(worktreeRoot, "task");
    await mkdir(baseRoot);
    await mkdir(taskRoot, { recursive: true });
    await writeFile(join(taskRoot, "README.md"), "fixture\n");
    const registry = await RootRegistry.fromConfig({
      repos: [{
        repo_id: "base",
        display_name: "Base",
        root: baseRoot,
        writes: { enabled: true, allowed_globs: ["**"], denied_globs: [] },
        lifecycle: {
          authority: "write",
          expected_remote_identity: "github.com/example/example",
          allowed_base_branches: ["main"],
          worktree_root: worktreeRoot,
          github_repository: "example/example",
          merge_method: "squash"
        }
      }],
      limits: {}
    });
    await registry.registerTaskRepo({
      task_id: "task-1",
      task_repo_id: "task-repo-1",
      base_repo_id: "base",
      authority: "implement",
      branch: "chat-pro/tasks/task-1",
      worktree: taskRoot
    });
    const guard = new RecordingTaskMutationRuntime();
    const server = createMcpServer({ registry, taskMutations: guard });
    const client = new Client({ name: "task-mutation-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const write = await client.callTool({
        name: "repo_write_file",
        arguments: {
          repo_id: "task-repo-1",
          operation_id: "operation-task-write",
          path: "README.md",
          action: "replace",
          find: "fixture",
          replace: "changed",
          dry_run: true
        }
      });
      expect(write.isError).toBeUndefined();
      expect(guard.tools).toEqual(["repo_write_file"]);

      const read = await client.callTool({
        name: "repo_fetch_file",
        arguments: { repo_id: "task-repo-1", path: "README.md" }
      });
      expect(read.isError).toBeUndefined();
      expect(guard.tools).toEqual(["repo_write_file"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

class RecordingTaskMutationRuntime implements TaskMutationRuntime {
  readonly tools: ToolName[] = [];

  async run(
    tool: ToolName,
    _input: Record<string, unknown>,
    invoke: () => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    this.tools.push(tool);
    return invoke();
  }
}
