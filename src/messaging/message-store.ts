import { z } from "zod";
import { TaskMessageGrantSchema } from "../config/task-messaging.js";
import { TaskMessageSendInputSchema, RecipientDeliverySchema, MessageDigestSchema } from "../contracts/task-messaging.contract.js";
import { canonicalJson, canonicalSha256, digestRecord } from "../task-runtime/canonical-json.js";
import { SecureRuntimeFs, hasCode } from "../task-runtime/secure-runtime-fs.js";
import { RepoReaderError } from "../runtime/errors.js";

export const MessageRecordSchema = z.object({
  schema_version: z.literal(1),
  key: MessageDigestSchema,
  input: TaskMessageSendInputSchema,
  input_sha256: MessageDigestSchema,
  envelope: z.string().max(16_000),
  recipients: z.array(z.object({
    grant: TaskMessageGrantSchema,
    delivery: RecipientDeliverySchema,
    turn_id: z.string().max(256).optional()
  }).strict()).min(1).max(8)
}).strict();
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

/** Shares the existing private fsync/atomic-write substrate; creates no managed task/run. */
export class TaskMessageStore {
  constructor(private readonly fs: SecureRuntimeFs) {}
  key(repoId: string, messageId: string): string { return canonicalSha256({ repoId, messageId }); }

  async read(key: string): Promise<MessageRecord | undefined> {
    const record = await this.load(`messaging/messages/${key}.json`, MessageRecordSchema);
    if (record && record.key !== key) throw invalidRecord();
    return record;
  }
  async write(record: MessageRecord): Promise<void> {
    await this.save(`messaging/messages/${record.key}.json`, MessageRecordSchema.parse(record));
  }
  async bindOperation(repoId: string, operationId: string, key: string, inputDigest: string): Promise<void> {
    const path = `messaging/operations/${canonicalSha256({ repoId, operationId })}.json`;
    const schema = z.object({ key: MessageDigestSchema, input_sha256: MessageDigestSchema }).strict();
    const existing = await this.load(path, schema);
    if (existing) {
      if (existing.key !== key || existing.input_sha256 !== inputDigest) throw new RepoReaderError("TASK_MESSAGE_CONFLICT", "Operation identity is already bound to another message.");
      return;
    }
    await this.save(path, { key, input_sha256: inputDigest });
  }
  async fence(target: string): Promise<string | null | undefined> {
    return (await this.load(`messaging/fences/${canonicalSha256({ target })}.json`, z.object({ key: MessageDigestSchema.nullable() }).strict()))?.key;
  }
  async setFence(target: string, key: string | null): Promise<void> {
    await this.save(`messaging/fences/${canonicalSha256({ target })}.json`, { key });
  }
  private async load<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T> | undefined> {
    try {
      const wrapped = z.object({ value: z.unknown(), sha256: MessageDigestSchema }).strict().parse(JSON.parse((await this.fs.readFile(path, 128 * 1024)).toString("utf8")));
      if (canonicalSha256(wrapped.value) !== wrapped.sha256) throw invalidRecord();
      return schema.parse(wrapped.value);
    } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw invalidRecord(); }
  }
  private async save(path: string, value: unknown): Promise<void> {
    await this.fs.atomicWrite(path, canonicalJson({ value, sha256: canonicalSha256(value) }));
  }
}
export function messageInputDigest(input: z.infer<typeof TaskMessageSendInputSchema>): string {
  return digestRecord(input, "operation_id");
}
function invalidRecord(): RepoReaderError { return new RepoReaderError("TASK_MESSAGE_CONFLICT", "Private messaging state is invalid; no replay is permitted."); }
