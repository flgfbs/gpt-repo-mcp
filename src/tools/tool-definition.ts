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
  handler: ToolHandler;
};

type ToolDefinitionInput = Omit<ToolDefinition, "description" | "inputSchema" | "outputSchema" | "requiredCapabilities"> & {
  requiredCapabilities?: readonly ToolCapability[];
};

export function defineTool(input: ToolDefinitionInput): ToolDefinition {
  const contract = toolContracts[input.name];
  return {
    ...input,
    description: descriptions[input.name],
    inputSchema: contract.input,
    outputSchema: contract.output,
    requiredCapabilities: input.requiredCapabilities ?? []
  };
}
