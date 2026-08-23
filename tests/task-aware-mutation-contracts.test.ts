import { describe, expect, test } from "vitest";
import { toolsForPackage } from "../src/tools/registry.js";
import { toolRegistry } from "../src/tools/registry.js";

describe("task-aware inherited mutation contracts", () => {
  test("adds optional operation, HEAD, and tree bindings without breaking base-repository calls", () => {
    const lifecycleNames = new Set(toolsForPackage("lifecycle").map((tool) => tool.name));
    const inheritedMutations = toolRegistry.filter((tool) => (
      tool.annotations.readOnlyHint === false && !lifecycleNames.has(tool.name)
    ));

    expect(inheritedMutations).toHaveLength(21);
    for (const tool of inheritedMutations) {
      for (const key of ["operation_id", "expected_head_sha", "expected_tree_sha"] as const) {
        const field = tool.inputSchema.shape[key];
        expect(field, `${tool.name}.${key}`).toBeDefined();
      }
      expect(tool.inputSchema.shape.operation_id?.isOptional(), `${tool.name}.operation_id remains optional for base repositories`).toBe(true);
      expect(tool.inputSchema.shape.expected_tree_sha?.isOptional(), `${tool.name}.expected_tree_sha remains optional for base repositories`).toBe(true);
    }
  });
});
