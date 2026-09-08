import { z } from "zod";
import {
  LifecycleArtifactRefSchema, LifecycleGitObjectIdSchema, LifecycleOperationIdSchema,
  LifecycleRepoIdSchema, LifecycleSha256Schema, LifecycleTaskIdSchema
} from "./lifecycle.contract.js";

export const RepoWritePushReconciliationInputSchema = z.object({
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  expected_head_sha: LifecycleGitObjectIdSchema,
  expected_tree_sha: LifecycleGitObjectIdSchema,
  original_operation_id: LifecycleOperationIdSchema,
  original_head_sha: LifecycleGitObjectIdSchema,
  original_tree_sha: LifecycleGitObjectIdSchema,
  observation_operation_id: LifecycleOperationIdSchema,
  expected_original_state_sha256: LifecycleSha256Schema.optional(),
  expected_observation_state_sha256: LifecycleSha256Schema.optional(),
  dry_run: z.boolean().default(true).describe("Inspect without recording; actual append requires both exact state digests.")
}).strict().superRefine((value, context) => {
  if (!value.dry_run && (!value.expected_original_state_sha256 || !value.expected_observation_state_sha256)) {
    context.addIssue({ code: "custom", message: "Recording requires exact original and observation state digests." });
  }
});

export const PushPublicationOutcomeSchema = z.enum([
  "EXACT_PUBLICATION_CONFIRMED", "LATER_PUBLICATION_CONFIRMED"
]);

export const RepoWritePushReconciliationResultSchema = z.object({
  ok: z.literal(true),
  schema: z.literal("push-readback-reconciliation.v1"),
  operation_id: LifecycleOperationIdSchema,
  repo_id: LifecycleRepoIdSchema,
  task_id: LifecycleTaskIdSchema,
  head_sha: LifecycleGitObjectIdSchema,
  tree_sha: LifecycleGitObjectIdSchema,
  original_operation_id: LifecycleOperationIdSchema,
  original_state_sha256: LifecycleSha256Schema,
  observation_operation_id: LifecycleOperationIdSchema,
  observation_state_sha256: LifecycleSha256Schema,
  observation_evidence_sha256: LifecycleSha256Schema,
  publication: PushPublicationOutcomeSchema,
  original_push_outcome: z.literal("UNKNOWN"),
  original_fence_preserved: z.literal(true),
  push_replayed: z.literal(false),
  dry_run: z.boolean(),
  recorded: z.boolean(),
  artifact: LifecycleArtifactRefSchema.nullable(),
  warnings: z.array(z.string()).max(100)
}).strict().superRefine((value, context) => {
  if (value.recorded !== !value.dry_run || value.recorded !== (value.artifact !== null)) {
    context.addIssue({ code: "custom", message: "Only a completed append has an artifact." });
  }
});

export type RepoWritePushReconciliationInput = z.infer<typeof RepoWritePushReconciliationInputSchema>;
export type RepoWritePushReconciliationResult = z.infer<typeof RepoWritePushReconciliationResultSchema>;
