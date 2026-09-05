import { openWorldMutationAnnotations, openWorldReadOnlyAnnotations } from "../annotations.js";
import { resolveTaskMessageRecipientHandler, sendTaskMessageHandler, readTaskMessageHandler } from "../handlers/task-messaging.js";
import { defineTool } from "../tool-definition.js";

export const taskMessagingTools = [
  defineTool({ name: "repo_task_message_resolve", title: "Resolve an existing task recipient", package: "task_messaging", tier: "specialist", annotations: openWorldReadOnlyAnnotations, handler: resolveTaskMessageRecipientHandler }),
  defineTool({ name: "repo_send_task_message", title: "Send bounded existing-task context", package: "task_messaging", tier: "specialist", annotations: openWorldMutationAnnotations, taskMutationBoundary: "self_managed_external", handler: sendTaskMessageHandler }),
  defineTool({ name: "repo_task_message_read", title: "Read existing-task message delivery", package: "task_messaging", tier: "specialist", annotations: openWorldReadOnlyAnnotations, handler: readTaskMessageHandler })
];
