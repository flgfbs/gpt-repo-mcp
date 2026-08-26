import { z } from "zod";
import {
  AgentRunnerNameSchema,
  AgentRunnerRunIdSchema,
  ExecutionDispatchIdSchema,
  ExecutionSupervisorServiceIdentitySchema
} from "./artifact-contracts.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const StableCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const AdmittedDispatchSchema = z.object({
  schema_version: z.literal(1),
  dispatch_id: ExecutionDispatchIdSchema,
  repo_id: z.string().min(1).max(200),
  run_id: AgentRunnerRunIdSchema,
  runner: AgentRunnerNameSchema,
  task_binding: z.object({
    task_id: z.string().min(1).max(128),
    task_repo_id: z.string().min(1).max(200),
    base_repo_id: z.string().min(1).max(200),
    head_sha: GitObjectIdSchema,
    tree_sha: GitObjectIdSchema,
    state_sha256: Sha256Schema,
    binding_sha256: Sha256Schema
  }).strict(),
  delegation_binding: z.object({
    manifest_canonical_sha256: Sha256Schema,
    task_sha256: Sha256Schema,
    baseline_sha256: Sha256Schema,
    prompt_sha256: Sha256Schema
  }).strict(),
  supervisor: ExecutionSupervisorServiceIdentitySchema,
  max_runtime_ms: z.number().int().positive(),
  launch_ordinal: z.literal(1),
  replay_policy: z.literal("never_after_launch_intent"),
  admitted_at: z.string().max(64).datetime(),
  admission_sha256: Sha256Schema,
  record_sha256: Sha256Schema
}).strict();

export const WorkerLaunchIntentSchema = z.object({
  schema_version: z.literal(1),
  dispatch_id: ExecutionDispatchIdSchema,
  launch_ordinal: z.literal(1),
  supervisor: ExecutionSupervisorServiceIdentitySchema,
  requested_at: z.string().max(64).datetime(),
  intent_sha256: Sha256Schema
}).strict();

export const WorkerLaunchOutcomeSchema = z.object({
  effect_state: z.enum(["no_external_effect", "known_complete", "known_failed", "unknown"]),
  provider_contact: z.enum(["none", "confirmed", "unknown"]),
  terminal_state: z.enum(["completed", "blocked", "failed", "unknown"]),
  outcome_code: StableCodeSchema
}).strict().superRefine((value, context) => {
  if (value.effect_state === "unknown" && value.terminal_state !== "unknown") {
    context.addIssue({ code: "custom", path: ["terminal_state"], message: "Unknown effects require an unknown terminal state." });
  }
  if (value.provider_contact === "unknown" && value.effect_state !== "unknown") {
    context.addIssue({ code: "custom", path: ["effect_state"], message: "Unknown provider contact requires an unknown effect state." });
  }
});

export const WorkerLaunchResultSchema = z.object({
  schema_version: z.literal(1),
  dispatch_id: ExecutionDispatchIdSchema,
  launch_ordinal: z.literal(1),
  effect_state: WorkerLaunchOutcomeSchema.shape.effect_state,
  provider_contact: WorkerLaunchOutcomeSchema.shape.provider_contact,
  terminal_state: WorkerLaunchOutcomeSchema.shape.terminal_state,
  outcome_code: StableCodeSchema,
  started_at: z.string().max(64).datetime(),
  completed_at: z.string().max(64).datetime(),
  replay_allowed: z.literal(false),
  result_sha256: Sha256Schema
}).strict().superRefine((value, context) => {
  const outcome = WorkerLaunchOutcomeSchema.safeParse({
    effect_state: value.effect_state,
    provider_contact: value.provider_contact,
    terminal_state: value.terminal_state,
    outcome_code: value.outcome_code
  });
  if (!outcome.success) {
    for (const issue of outcome.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
});

export type AdmittedDispatch = z.infer<typeof AdmittedDispatchSchema>;
export type WorkerLaunchIntent = z.infer<typeof WorkerLaunchIntentSchema>;
export type WorkerLaunchOutcome = z.infer<typeof WorkerLaunchOutcomeSchema>;
export type WorkerLaunchResult = z.infer<typeof WorkerLaunchResultSchema>;
