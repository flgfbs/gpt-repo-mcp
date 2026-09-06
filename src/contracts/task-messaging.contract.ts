/* eslint-disable no-control-regex -- Reject control bytes at the public messaging boundary. */
import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";
import { LifecycleOperationIdSchema } from "./lifecycle.contract.js";

export const MessageIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
export const MessageDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MessageModeSchema = z.enum(["notify", "continue"]);
export const MessageReasonSchema = z.enum([
  "none", "disabled", "not_authorized", "binding_mismatch", "offline",
  "unsupported_namespace", "passive_transport_unverified", "not_loaded",
  "direct_input_unavailable", "rejected", "transport_uncertain",
  "readback_unavailable", "readback_mismatch", "prior_message_unresolved"
]);
const RecipientRefSchema = z.object({
  recipient_id: MessageIdSchema,
  expected_binding_sha256: MessageDigestSchema
}).strict();

export const TaskMessageResolveInputSchema = RepoInputSchema.extend({
  recipient_id: MessageIdSchema.describe("Owner-configured recipient alias, never a managed run or inferred title.")
}).strict();
export const TaskMessageSendInputSchema = RepoInputSchema.extend({
  operation_id: LifecycleOperationIdSchema,
  message_id: MessageIdSchema.describe("Stable sender message identity. Keep it unchanged across disconnects and operation IDs."),
  recipients: z.array(RecipientRefSchema).min(1).max(8)
    .refine((items) => new Set(items.map((item) => item.recipient_id)).size === items.length, "Duplicate recipients are forbidden."),
  mode: MessageModeSchema.describe("notify never wakes or steers. continue explicitly permits generation or feeding an active turn."),
  summary: z.string().trim().min(1).max(2_000).refine((value) => !/[\x00-\x08\x0b-\x1f]/.test(value)),
  evidence: z.array(z.object({
    repo_id: MessageIdSchema,
    path: z.string().min(1).max(256).regex(/^(?!\/|.*(?:^|\/)\.\.(?:\/|$)|.*[:\\\x00-\x1f])[A-Za-z0-9_./-]+$/)
  }).strict()).max(8).default([])
}).strict();
export const TaskMessageReadInputSchema = RepoInputSchema.extend({ message_id: MessageIdSchema }).strict();
export const TaskMessageResolveResultSchema = z.object({
  ok: z.literal(true), repo_id: z.string(), recipient_id: MessageIdSchema,
  binding_sha256: MessageDigestSchema.nullable(),
  namespace: z.enum(["codex_ui_task", "managed_app_server_run", "chatgpt_task", "unknown"]),
  status: z.enum(["idle", "active", "notLoaded", "systemError", "unavailable"]),
  notification_supported: z.literal(false),
  continuation_supported: z.boolean(),
  continuation_effect: z.literal("start_or_feed_active_turn"),
  reason: MessageReasonSchema,
  passive_reason: z.literal("passive_transport_unverified")
}).strict();
export const RecipientDeliverySchema = z.object({
  recipient_id: MessageIdSchema,
  binding_sha256: MessageDigestSchema,
  state: z.enum(["prepared", "not_delivered", "accepted", "persistence_verified", "uncertain"]),
  reason: MessageReasonSchema,
  accepted_turn_ref: MessageDigestSchema.nullable(),
  persisted_item_ref: MessageDigestSchema.nullable(),
  acknowledgement: z.literal("unobserved"),
  replay_allowed: z.literal(false)
}).strict();
export const TaskMessageResultSchema = z.object({
  ok: z.literal(true), repo_id: z.string(), message_id: MessageIdSchema,
  mode: MessageModeSchema, message_sha256: MessageDigestSchema,
  recipients: z.array(RecipientDeliverySchema).min(1).max(8)
}).strict();
export type TaskMessageSendInput = z.infer<typeof TaskMessageSendInputSchema>;
export type TaskMessageResolveResult = z.infer<typeof TaskMessageResolveResultSchema>;
export type TaskMessageResult = z.infer<typeof TaskMessageResultSchema>;
export type RecipientDelivery = z.infer<typeof RecipientDeliverySchema>;
