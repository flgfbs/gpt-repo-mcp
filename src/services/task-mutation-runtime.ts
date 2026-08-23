import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolName } from "../tools/contracts.js";

/**
 * Runtime boundary for inherited mutating tools when their repo_id resolves to
 * a task worktree. The implementation owns durable idempotency and exact
 * HEAD/tree checks; base-repository calls bypass this boundary unchanged.
 */
export interface TaskMutationRuntime {
  run(
    tool: ToolName,
    input: Record<string, unknown>,
    invoke: () => Promise<CallToolResult>
  ): Promise<CallToolResult>;
}
