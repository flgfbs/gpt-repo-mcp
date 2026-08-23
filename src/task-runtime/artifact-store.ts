import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { z, ZodError } from "zod";
import { SecretScanner } from "../services/secret-scanner.js";
import { IgnoreEngine } from "../services/ignore-engine.js";
import { canonicalJson, canonicalSha256, digestRecord, hashedDiskKey, sha256Hex } from "./canonical-json.js";
import { CrossProcessLockManager } from "./cross-process-lock.js";
import { Sha256Schema, TaskIdSchema } from "./contracts.js";
import { TaskRuntimeError } from "./errors.js";
import { hasCode, validateManagedRelativePath } from "./secure-runtime-fs.js";
import { TaskStateStore } from "./state-store.js";

const artifactIgnoreEngine = new IgnoreEngine();

export const TaskArtifactIdSchema = z.string().regex(/^artifact_[A-Za-z0-9_-]{16,160}$/);
export const TaskArtifactKindSchema = z.enum([
  "task_manifest",
  "operation_receipt",
  "validation_log",
  "large_diff",
  "remote_observation",
  "push_receipt",
  "pull_request",
  "review_evidence",
  "ci_evidence",
  "merge_gate_evidence",
  "merge_receipt",
  "post_merge_evidence"
]);
export const TaskArtifactMediaTypeSchema = z.enum([
  "text/plain",
  "text/markdown",
  "text/x-diff",
  "application/json",
  "application/x-ndjson"
]);

const TaskArtifactMetadataSchema = z.object({
  schema_version: z.literal(1),
  task_id: TaskIdSchema,
  artifact_id: TaskArtifactIdSchema,
  kind: TaskArtifactKindSchema,
  media_type: TaskArtifactMediaTypeSchema,
  logical_path: z.string().min(1).max(1_024),
  content_sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  metadata_sha256: Sha256Schema
}).strict();

export type TaskArtifactMetadata = z.infer<typeof TaskArtifactMetadataSchema>;
export const TaskArtifactPublicReferenceSchema = z.object({
  artifact_id: TaskArtifactIdSchema,
  kind: TaskArtifactKindSchema,
  media_type: TaskArtifactMediaTypeSchema,
  content_sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative()
}).strict();
export type TaskArtifactPublicReference = z.infer<typeof TaskArtifactPublicReferenceSchema>;

export type TaskArtifactStoreOptions = {
  maxArtifactBytes?: number;
  maxRangeBytes?: number;
  now?: () => Date;
};

export class TaskArtifactStore {
  private readonly maxArtifactBytes: number;
  private readonly maxRangeBytes: number;
  private readonly now: () => Date;
  private readonly scanner = new SecretScanner();

  constructor(
    private readonly states: TaskStateStore,
    private readonly locks: CrossProcessLockManager,
    options: TaskArtifactStoreOptions = {}
  ) {
    this.maxArtifactBytes = boundedSize(options.maxArtifactBytes ?? 4 * 1024 * 1024, "maxArtifactBytes");
    this.maxRangeBytes = boundedSize(options.maxRangeBytes ?? 256 * 1024, "maxRangeBytes");
    if (this.maxRangeBytes > this.maxArtifactBytes) {
      throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "maxRangeBytes cannot exceed maxArtifactBytes.");
    }
    this.now = options.now ?? (() => new Date());
  }

  async put(input: {
    task_id: string;
    kind: z.input<typeof TaskArtifactKindSchema>;
    media_type: z.input<typeof TaskArtifactMediaTypeSchema>;
    logical_path: string;
    content: Buffer | string;
  }): Promise<TaskArtifactMetadata> {
    const taskId = TaskIdSchema.parse(input.task_id);
    return this.locks.withLock(`task:${taskId}`, async () => {
      const task = await this.states.requireTask(taskId);
      if (task.lifecycle === "CLEANED") throw new TaskRuntimeError("TASK_NOT_OPEN", "Cleaned tasks cannot accept new artifacts.");
      const kind = TaskArtifactKindSchema.parse(input.kind);
      const mediaType = TaskArtifactMediaTypeSchema.parse(input.media_type);
      const logicalPath = validateArtifactLogicalPath(input.logical_path);
      const content = Buffer.isBuffer(input.content) ? Buffer.from(input.content) : Buffer.from(input.content, "utf8");
      if (content.length > this.maxArtifactBytes) {
        throw new TaskRuntimeError("RUNTIME_SIZE_LIMIT", "Artifact exceeds the configured byte limit.", {
          max_bytes: this.maxArtifactBytes,
          size: content.length
        });
      }
      const decoded = decodeUtf8(content);
      validateContentType(mediaType, decoded);
      if (this.scanner.hasSecretValue(decoded)) {
        throw new TaskRuntimeError("ARTIFACT_SECRET_BLOCKED", "Artifact contains secret-looking content.");
      }

      const digest = sha256Hex(content);
      await this.locks.withLock(`cas:${digest}`, async () => {
        const relative = casPath(digest);
        try {
          const existing = await this.states.fs.readFile(relative, this.maxArtifactBytes);
          if (sha256Hex(existing) !== digest || !existing.equals(content)) {
            throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Content-addressed artifact bytes do not match their digest.");
          }
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
          await this.states.fs.atomicWrite(relative, content, { exclusive: true });
        }
      });

      return this.locks.withLock(`artifacts:${taskId}`, async () => {
        const artifactId = `artifact_${randomUUID().replaceAll("-", "")}`;
        const unsigned = {
          schema_version: 1 as const,
          task_id: taskId,
          artifact_id: artifactId,
          kind,
          media_type: mediaType,
          logical_path: logicalPath,
          content_sha256: digest,
          byte_length: content.length,
          created_at: this.now().toISOString()
        };
        const metadata = TaskArtifactMetadataSchema.parse({
          ...unsigned,
          metadata_sha256: canonicalSha256(unsigned)
        });
        await this.states.fs.atomicWrite(metadataPath(taskId, artifactId), `${canonicalJson(metadata)}\n`, { exclusive: true });
        return metadata;
      });
    });
  }

  async read(input: { task_id: string; artifact_id: string; offset?: number; length?: number }): Promise<{
    artifact: TaskArtifactMetadata;
    offset: number;
    length: number;
    total_bytes: number;
    eof: boolean;
    content_base64: string;
  }> {
    const taskId = TaskIdSchema.parse(input.task_id);
    const artifactId = TaskArtifactIdSchema.parse(input.artifact_id);
    await this.states.requireTask(taskId);
    const metadata = await this.readMetadata(taskId, artifactId);
    const offset = input.offset ?? 0;
    const length = input.length ?? this.maxRangeBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > this.maxRangeBytes) {
      throw new TaskRuntimeError("ARTIFACT_RANGE_INVALID", "Artifact ranges require a non-negative offset and bounded positive length.", {
        max_range_bytes: this.maxRangeBytes
      });
    }
    if (offset > metadata.byte_length) {
      throw new TaskRuntimeError("ARTIFACT_RANGE_INVALID", "Artifact range offset exceeds the content length.");
    }
    const content = await this.states.fs.readFile(casPath(metadata.content_sha256), this.maxArtifactBytes);
    if (content.length !== metadata.byte_length || sha256Hex(content) !== metadata.content_sha256) {
      throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Artifact content digest or length does not match its metadata.");
    }
    const end = Math.min(content.length, offset + length);
    const selected = content.subarray(offset, end);
    return {
      artifact: metadata,
      offset,
      length: selected.length,
      total_bytes: content.length,
      eof: end === content.length,
      content_base64: selected.toString("base64")
    };
  }

  async listMetadata(taskIdInput: string, options: { limit?: number } = {}): Promise<TaskArtifactMetadata[]> {
    const taskId = TaskIdSchema.parse(taskIdInput);
    await this.states.requireTask(taskId);
    const limit = boundedMetadataLimit(options.limit ?? 1_000);
    return this.locks.withLock(`artifacts:${taskId}`, async () => {
      const directory = artifactDirectory(taskId);
      let entries;
      try {
        entries = await this.states.fs.listDirectory(directory, limit);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return [];
        throw error;
      }
      const metadata: TaskArtifactMetadata[] = [];
      for (const entry of entries) {
        if (entry.kind !== "file" || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Artifact metadata directory contains an unsafe or malformed entry.", {
            disk_key: entry.name,
            kind: entry.kind
          });
        }
        const artifact = await this.readMetadataAtPath(taskId, posix.join(directory, entry.name));
        if (`${hashedDiskKey("artifact", artifact.artifact_id)}.json` !== entry.name) throw invalidArtifact();
        metadata.push(artifact);
      }
      return metadata.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.artifact_id.localeCompare(right.artifact_id));
    });
  }

  private async readMetadata(taskId: string, artifactId: string): Promise<TaskArtifactMetadata> {
    try {
      const metadata = await this.readMetadataAtPath(taskId, metadataPath(taskId, artifactId));
      if (metadata.task_id !== taskId || metadata.artifact_id !== artifactId) throw invalidArtifact();
      return metadata;
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new TaskRuntimeError("ARTIFACT_NOT_FOUND", "Artifact is not available to this task.");
      }
      if (error instanceof SyntaxError || error instanceof ZodError) throw invalidArtifact();
      throw error;
    }
  }

  private async readMetadataAtPath(taskId: string, relativePath: string): Promise<TaskArtifactMetadata> {
    try {
      const raw = await this.states.fs.readFile(relativePath, 64 * 1024);
      const metadata = TaskArtifactMetadataSchema.parse(JSON.parse(raw.toString("utf8")));
      if (metadata.task_id !== taskId) throw invalidArtifact();
      try {
        validateArtifactLogicalPath(metadata.logical_path);
      } catch {
        throw invalidArtifact();
      }
      if (digestRecord(metadata as TaskArtifactMetadata & Record<string, unknown>, "metadata_sha256") !== metadata.metadata_sha256) {
        throw invalidArtifact();
      }
      return metadata;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) throw invalidArtifact();
      throw error;
    }
  }
}

export function artifactDirectory(taskId: string): string {
  return posix.join("tasks", hashedDiskKey("task", TaskIdSchema.parse(taskId)), "artifacts");
}

export function metadataPath(taskId: string, artifactId: string): string {
  const parsedArtifactId = TaskArtifactIdSchema.parse(artifactId);
  return posix.join(
    artifactDirectory(taskId),
    `${hashedDiskKey("artifact", parsedArtifactId)}.json`
  );
}

export function casPath(digest: string): string {
  Sha256Schema.parse(digest);
  return posix.join("cas", "sha256", digest.slice(0, 2), digest.slice(2));
}

export function toTaskArtifactPublicReference(metadata: TaskArtifactMetadata): TaskArtifactPublicReference {
  const parsed = TaskArtifactMetadataSchema.parse(metadata);
  if (digestRecord(parsed as TaskArtifactMetadata & Record<string, unknown>, "metadata_sha256") !== parsed.metadata_sha256) {
    throw invalidArtifact();
  }
  return TaskArtifactPublicReferenceSchema.parse({
    artifact_id: parsed.artifact_id,
    kind: parsed.kind,
    media_type: parsed.media_type,
    content_sha256: parsed.content_sha256,
    byte_length: parsed.byte_length
  });
}

function validateArtifactLogicalPath(value: string): string {
  if (value.length === 0 || value.length > 1_024) {
    throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "Artifact logical path is missing or too long.");
  }
  const normalized = validateManagedRelativePath(value);
  if (normalized === "." || normalized !== value) {
    throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "Artifact logical path must already be canonical.");
  }
  const basename = normalized.toLowerCase().split("/").at(-1)!;
  if (
    artifactIgnoreEngine.isSensitiveCandidate(normalized)
    || /\.(?:jks|keystore)$/.test(basename)
  ) {
    throw new TaskRuntimeError("ARTIFACT_SECRET_BLOCKED", "Secret-candidate artifact paths are not allowed.");
  }
  return normalized;
}

function decodeUtf8(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "Task artifacts must contain valid UTF-8 text.");
  }
}

function validateContentType(mediaType: z.infer<typeof TaskArtifactMediaTypeSchema>, content: string): void {
  if (content.includes("\0")) throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "NUL bytes are not allowed in task artifacts.");
  if (mediaType === "application/json") {
    try {
      JSON.parse(content);
    } catch {
      throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "application/json artifacts must contain valid JSON.");
    }
  }
  if (mediaType === "application/x-ndjson") {
    try {
      for (const line of content.split("\n").filter((entry) => entry.trim().length > 0)) JSON.parse(line);
    } catch {
      throw new TaskRuntimeError("ARTIFACT_TYPE_BLOCKED", "application/x-ndjson artifacts must contain valid JSON lines.");
    }
  }
}

function invalidArtifact(): TaskRuntimeError {
  return new TaskRuntimeError("TASK_STATE_TAMPERED", "Artifact metadata is malformed or its digest does not match.");
}

function boundedSize(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", `${name} must be between 1 byte and 64 MiB.`);
  }
  return value;
}

function boundedMetadataLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "Artifact metadata list limit must be an integer between 1 and 10000.");
  }
  return value;
}
