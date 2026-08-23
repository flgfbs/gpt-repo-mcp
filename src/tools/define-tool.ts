import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { ToolDefinition } from "./tool-definition.js";

export function registerCatalogTool(server: McpServer, context: RuntimeContext, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema.shape,
      outputSchema: tool.outputSchema.shape,
      annotations: tool.annotations
    },
    async (args) => {
      const taskBinding = typeof args.repo_id === "string"
        ? context.registry.taskBinding(args.repo_id)
        : undefined;
      if (
        taskBinding
        && tool.package !== "lifecycle"
        && tool.annotations.readOnlyHint === false
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
