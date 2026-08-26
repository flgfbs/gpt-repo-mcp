import { z } from "zod";
import { AgentRunnerRunIdSchema } from "../delegation/artifact-contracts.js";
import { LifecycleOperationIdSchema } from "./lifecycle.contract.js";
import { RepoInputSchema } from "./repo.contract.js";

const ContinuationInstructionSchema = z.string()
  .min(1)
  .max(8_000)
  .refine((value) => !value.includes("\0"), "NUL characters are not allowed.");

export const AgentContinuationInputSchema = RepoInputSchema.extend({
  run_id: AgentRunnerRunIdSchema.describe("Exact managed agent run to continue."),
  operation_id: LifecycleOperationIdSchema.describe("Stable operation id in the existing task operation namespace."),
  expected_revision: z.number().int().nonnegative()
    .describe("Exact repo_agent_runs status revision observed before requesting continuation."),
  instruction: ContinuationInstructionSchema
    .describe("Bounded next-turn instruction. Thread, model, machine, repository path, and authority overrides are not accepted.")
}).strict();

export const AgentContinuationResultSchema = z.object({
  ok: z.literal(true),
  repo_id: z.string().min(1),
  run_id: AgentRunnerRunIdSchema,
  operation_id: LifecycleOperationIdSchema,
  accepted: z.literal(true),
  turn_index: z.number().int().min(1).max(32),
  revision: z.number().int().nonnegative(),
  next_tool_payloads: z.object({
    repo_agent_runs: z.object({
      repo_id: z.string().min(1),
      run_id: AgentRunnerRunIdSchema,
      wait_after_revision: z.number().int().nonnegative()
    }).strict()
  }).strict(),
  warnings: z.array(z.string().max(500)).max(20)
}).strict();

export type AgentContinuationInput = z.infer<typeof AgentContinuationInputSchema>;
export type AgentContinuationResult = z.infer<typeof AgentContinuationResultSchema>;
