import { describe, expect, test } from "vitest";
import { toolsForPackage } from "../src/tools/registry.js";
import { toolRegistry } from "../src/tools/registry.js";

describe("task-aware inherited mutation contracts", () => {
  test("adds optional operation, HEAD, and tree bindings without breaking base-repository calls", () => {
    const lifecycleNames = new Set(toolsForPackage("lifecycle").map((tool) => tool.name));
    const inheritedMutations = toolRegistry.filter((tool) => (
      tool.annotations.readOnlyHint === false
      && !lifecycleNames.has(tool.name)
      && tool.name !== "repo_finalize_codex_run"
    ));

    expect(inheritedMutations).toHaveLength(21);
    for (const tool of inheritedMutations) {
      for (const key of ["operation_id", "expected_head_sha", "expected_tree_sha"] as const) {
        const field = tool.inputSchema.shape[key];
        expect(field, `${tool.name}.${key}`).toBeDefined();
      }
      const operationField = tool.inputSchema.shape.operation_id as unknown as { safeParse(value: unknown): { success: boolean } };
      const treeField = tool.inputSchema.shape.expected_tree_sha as unknown as { safeParse(value: unknown): { success: boolean } };
      expect(operationField.safeParse(undefined).success, `${tool.name}.operation_id remains optional for base repositories`).toBe(true);
      expect(treeField.safeParse(undefined).success, `${tool.name}.expected_tree_sha remains optional for base repositories`).toBe(true);
    }
  });

  test("requires exact operation, HEAD, and tree bindings for repo_finalize_codex_run", () => {
    const finalizer = toolRegistry.find((tool) => tool.name === "repo_finalize_codex_run");
    expect(finalizer).toBeDefined();
    for (const key of ["operation_id", "expected_head_sha", "expected_tree_sha"] as const) {
      const field = finalizer?.inputSchema.shape[key] as unknown as { safeParse(value: unknown): { success: boolean } };
      expect(field.safeParse(undefined).success, `repo_finalize_codex_run.${key} is required`).toBe(false);
    }
  });
});
