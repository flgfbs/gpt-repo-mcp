import { z } from "zod";
import { TaskMessageResolveInputSchema, TaskMessageSendInputSchema, TaskMessageReadInputSchema } from "../../contracts/task-messaging.contract.js";
import { RepoReaderError } from "../../runtime/errors.js";
import { createSuccessEnvelope } from "../../runtime/result-envelope.js";
import { safeTool, type ToolHandler } from "../handler-support.js";

export const resolveTaskMessageRecipientHandler: ToolHandler = (input, context) => safeTool<z.infer<typeof TaskMessageResolveInputSchema>>("repo_task_message_resolve", input, async (args) => {
  if (!context.taskMessaging) throw unavailable();
  return createSuccessEnvelope(await context.taskMessaging.resolve(args), "Resolved bounded recipient capability.");
});
export const sendTaskMessageHandler: ToolHandler = (input, context) => safeTool<z.infer<typeof TaskMessageSendInputSchema>>("repo_send_task_message", input, async (args) => {
  if (!context.taskMessaging) throw unavailable();
  return createSuccessEnvelope(await context.taskMessaging.send(args), "Recorded per-recipient delivery evidence; inspect each state.");
});
export const readTaskMessageHandler: ToolHandler = (input, context) => safeTool<z.infer<typeof TaskMessageReadInputSchema>>("repo_task_message_read", input, async (args) => {
  if (!context.taskMessaging) throw unavailable();
  return createSuccessEnvelope(await context.taskMessaging.read(args), "Read delivery evidence without resending.");
});
function unavailable(): RepoReaderError { return new RepoReaderError("TASK_MESSAGE_DENIED", "Existing-task messaging runtime is not configured."); }
