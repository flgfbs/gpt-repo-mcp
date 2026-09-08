import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { ToolDefinition } from "./tool-definition.js";
import { toRepoReaderError } from "../runtime/errors.js";
import { createErrorEnvelope } from "../runtime/result-envelope.js";

export function registerCatalogTool(server: McpServer, context: RuntimeContext, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // Preserve legacy wire contracts. The additive reconciliation boundary must keep
      // its strict object and cross-field refinements instead of registering only fields.
      inputSchema: tool.name === "repo_write_push_reconciliation" ? tool.inputSchema : tool.inputSchema.shape,
      outputSchema: tool.name === "repo_write_push_reconciliation" ? tool.outputSchema : tool.outputSchema.shape,
      annotations: tool.annotations
    },
    async (args: Record<string, unknown>) => {
      try {
        if (typeof args.repo_id === "string") await context.registry.refreshForRepo(args.repo_id);
      } catch (error) {
        return createErrorEnvelope(toRepoReaderError(error));
      }
      const taskBinding = typeof args.repo_id === "string"
        ? context.registry.taskBinding(args.repo_id)
        : undefined;
      if (
        taskBinding
        && tool.package !== "lifecycle"
        && tool.annotations.readOnlyHint === false
        && tool.taskMutationBoundary === "inherited"
      ) {
        if (!context.taskMutations) {
          throw new Error("Task mutation runtime is not configured.");
        }
        return context.taskMutations.run(tool.name, args, () => tool.handler(args, context));
      }
      return tool.handler(args, context);
    }
  );
}
