/* eslint-disable no-control-regex -- Private protocol identifiers must reject control bytes. */
import { isAbsolute } from "node:path";
import { z } from "zod";
import { MessageIdSchema, MessageModeSchema } from "../contracts/task-messaging.contract.js";

const PrivateIdSchema = z.string().min(1).max(256).refine((value) => !/[\x00-\x20]/.test(value));
const NativeTaskIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const GrantBase = z.object({
  recipient_id: MessageIdSchema,
  source_repo_id: MessageIdSchema,
  owner_uid: z.number().int().nonnegative(),
  relationship: z.enum(["owner_specified", "parent", "child", "dependency"]),
  modes: z.array(MessageModeSchema).min(1).max(2)
});
export const TaskMessageGrantSchema = z.discriminatedUnion("namespace", [
  GrantBase.extend({
    namespace: z.literal("codex_ui_task"),
    target_id: NativeTaskIdSchema,
    session_id: NativeTaskIdSchema,
    created_at: z.number().int().nonnegative(),
    cwd: z.string().max(4_096).refine(isAbsolute).refine((value) => !value.includes("\0")),
    project_id: PrivateIdSchema.nullable(),
    model_provider: PrivateIdSchema,
    source: z.enum(["cli", "vscode", "exec", "appServer"])
  }).strict(),
  GrantBase.extend({
    namespace: z.enum(["chatgpt_task", "managed_app_server_run"]),
    target_id: PrivateIdSchema
  }).strict()
]);
export const TaskMessagingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  grants: z.array(TaskMessageGrantSchema).max(128).default([])
}).strict().superRefine((value, context) => {
  const aliases = new Set<string>();
  const targets = new Set<string>();
  for (const grant of value.grants) {
    const alias = `${grant.source_repo_id}:${grant.recipient_id}`;
    const target = `${grant.source_repo_id}:${grant.namespace}:${grant.target_id}`;
    if (aliases.has(alias) || targets.has(target)) context.addIssue({ code: "custom", message: "Ambiguous messaging grant." });
    aliases.add(alias); targets.add(target);
  }
});
export type TaskMessageGrant = z.infer<typeof TaskMessageGrantSchema>;
export type CodexTaskMessageGrant = Extract<TaskMessageGrant, { namespace: "codex_ui_task" }>;
