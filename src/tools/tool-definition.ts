import type { ToolHandler } from "./handler-support.js";
import {
  idempotentWriteAnnotations,
  nonDestructiveMutationAnnotations,
  openWorldMutationAnnotations,
  openWorldNonDestructiveMutationAnnotations,
  openWorldReadOnlyAnnotations,
  readOnlyAnnotations,
  safeMutationAnnotations,
  writeAnnotations
} from "./annotations.js";
import { descriptions } from "./descriptions.js";
import { toolContracts, type ToolContract, type ToolName } from "./contracts.js";

export type ToolPackage =
  | "developer"
  | "delegation"
  | "task_messaging"
  | "patchsets"
  | "advanced_operations"
  | "diagnostics_and_discovery"
  | "code_index"
  | "lifecycle";

export type ToolTier = "default" | "specialist";
export type ToolCapability = "code_intelligence" | "lifecycle";
export type ToolAnnotationSet =
  | typeof readOnlyAnnotations
  | typeof writeAnnotations
  | typeof safeMutationAnnotations
  | typeof nonDestructiveMutationAnnotations
  | typeof idempotentWriteAnnotations
  | typeof openWorldReadOnlyAnnotations
  | typeof openWorldMutationAnnotations
  | typeof openWorldNonDestructiveMutationAnnotations;

export type ToolDefinition = {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: ToolContract["input"];
  outputSchema: ToolContract["output"];
  annotations: ToolAnnotationSet;
  package: ToolPackage;
  tier: ToolTier;
  requiredCapabilities: readonly ToolCapability[];
  taskMutationBoundary: "inherited" | "self_managed_external";
  handler: ToolHandler;
};

type ToolDefinitionInput = Omit<ToolDefinition, "description" | "inputSchema" | "outputSchema" | "requiredCapabilities" | "taskMutationBoundary"> & {
  requiredCapabilities?: readonly ToolCapability[];
  taskMutationBoundary?: ToolDefinition["taskMutationBoundary"];
};

export function defineTool(input: ToolDefinitionInput): ToolDefinition {
  if (input.taskMutationBoundary === "self_managed_external" && !["repo_continue_agent_run", "repo_send_task_message"].includes(input.name)) {
    throw new Error("Only continuation and existing-task messaging may own self-managed external operations.");
  }
  const contract = toolContracts[input.name];
  return {
    ...input,
    description: descriptions[input.name],
    inputSchema: contract.input,
    outputSchema: contract.output,
    requiredCapabilities: input.requiredCapabilities ?? [],
    taskMutationBoundary: input.taskMutationBoundary ?? "inherited"
  };
}
