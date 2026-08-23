import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RepoReaderError } from "../runtime/errors.js";
import { createErrorEnvelope, redactHostPaths } from "../runtime/result-envelope.js";
import {
  TaskArtifactStore,
  TaskMutationStore,
  canonicalJson,
  canonicalSha256,
  type TaskMutationRecord,
  type TaskRuntimeService
} from "../task-runtime/index.js";
import type { ToolName } from "../tools/contracts.js";
import type { RootRegistry } from "./root-registry.js";
import type { TaskMutationRuntime } from "./task-mutation-runtime.js";
import {
  readValidationArtifactCapture,
  type ValidationArtifactCapture
} from "./validation-artifact-capture.js";

const MAX_RESULT_DIGEST_BYTES = 1024 * 1024;

export class DurableTaskMutationRuntime implements TaskMutationRuntime {
  private readonly store: TaskMutationStore;

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    private readonly artifacts?: TaskArtifactStore,
    private readonly now: () => Date = () => new Date()
  ) {
    this.store = new TaskMutationStore(tasks.fs);
  }

  async run(
    tool: ToolName,
    input: Record<string, unknown>,
    invoke: () => Promise<CallToolResult>
  ): Promise<CallToolResult> {
    try {
      const binding = requireMutationBinding(input);
      const registered = this.registry.taskBinding(binding.repoId);
      if (!registered) return taskError("TASK_STATE_MISMATCH", "repo_id is not an active task repository.");
      const requestSha256 = canonicalSha256({ schema_version: 1, tool, input: jsonValue(input) });

      return await this.tasks.locks.withLock(`mutation-operation:${binding.operationId}`, async () => {
      const existing = await this.store.read(binding.operationId);
      if (existing) return this.handleExisting(existing, tool, registered.task_id, binding.repoId, requestSha256);
      const timestamp = this.now().toISOString();
      let record = await this.store.create({
        operation_id: binding.operationId,
        task_id: registered.task_id,
        repo_id: binding.repoId,
        tool,
        request_sha256: requestSha256,
        phase: "ADMITTED",
        before_head_sha: binding.expectedHead,
        before_tree_sha: binding.expectedTree,
        created_at: timestamp,
        updated_at: timestamp
      });
      if (record.request_sha256 !== requestSha256 || record.task_id !== registered.task_id || record.tool !== tool) {
        return taskError("TASK_OPERATION_CONFLICT", "operation_id is already bound to a different task mutation.", record);
      }

      try {
        const execution = await this.tasks.runWithExactTaskState({
          task_id: registered.task_id,
          expected_head: binding.expectedHead,
          expected_tree: binding.expectedTree
        }, async () => {
          record = await this.store.transition(record, "LOCAL_MUTATION_STARTED", {}, this.now().toISOString());
          return invoke();
        });
        await this.persistValidationArtifact(tool, binding.operationId, registered.task_id, execution, execution.result);
        const resultSha256 = digestResult(execution.result);
        record = await this.store.transition(record, "LOCAL_MUTATION_COMPLETE", {
          after_head_sha: execution.after.head,
          after_tree_sha: execution.after.tree,
          result_sha256: resultSha256,
          result_is_error: execution.result.isError === true
        }, this.now().toISOString());
        return execution.result;
      } catch (error) {
        const code = stableFailureCode(error);
        try {
          const current = await this.store.read(binding.operationId);
          if (current && (current.phase === "ADMITTED" || current.phase === "LOCAL_MUTATION_STARTED")) {
            record = await this.store.transition(current, "BLOCKED", { failure_code: code }, this.now().toISOString());
          }
        } catch {
          return taskError("TASK_OPERATION_BLOCKED", "Task mutation failed and its durable recovery state could not be advanced safely.", record);
        }
        return taskError("TASK_OPERATION_BLOCKED", "Task mutation is blocked and will not be replayed automatically.", record);
      }
      });
    } catch (error) {
      if (error instanceof RepoReaderError) return createErrorEnvelope(error);
      return taskError("TASK_STATE_MISMATCH", "Task mutation admission failed closed.");
    }
  }

  private async persistValidationArtifact(
    tool: ToolName,
    operationId: string,
    taskId: string,
    execution: {
      before: { head: string; tree: string };
      after: { head: string; tree: string };
    },
    result: CallToolResult
  ): Promise<void> {
    if (tool !== "repo_validate") return;
    const capture = readValidationArtifactCapture(result.structuredContent);
    if (!capture || !this.artifacts) {
      throw new RepoReaderError("TASK_OPERATION_BLOCKED", "Task validation did not produce a durable full-log artifact payload.");
    }
    const artifact = await this.artifacts.put({
      task_id: taskId,
      kind: "validation_log",
      media_type: "application/json",
      logical_path: `validation/${capture.validation_id}.json`,
      content: `${canonicalJson({
        schema_version: 1,
        task_id: taskId,
        operation_id: operationId,
        expected_head_sha: execution.before.head,
        expected_tree_sha: execution.before.tree,
        resulting_head_sha: execution.after.head,
        resulting_tree_sha: execution.after.tree,
        validation: sanitizeValidationCapture(capture)
      })}\n`
    });
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new RepoReaderError("TASK_OPERATION_BLOCKED", "Task validation returned no structured content for its artifact reference.");
    }
    (result.structuredContent as Record<string, unknown>).validation_artifact = {
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      media_type: artifact.media_type,
      byte_length: artifact.byte_length,
      sha256: artifact.content_sha256,
      created_at: artifact.created_at
    };
  }

  private handleExisting(
    record: TaskMutationRecord,
    tool: ToolName,
    taskId: string,
    repoId: string,
    requestSha256: string
  ): CallToolResult {
    if (
      record.tool !== tool
      || record.task_id !== taskId
      || record.repo_id !== repoId
      || record.request_sha256 !== requestSha256
    ) {
      return taskError("TASK_OPERATION_CONFLICT", "operation_id is already bound to a different task mutation.", record);
    }
    if (record.phase === "LOCAL_MUTATION_COMPLETE" && record.result_sha256) {
      return taskError(
        "TASK_OPERATION_ALREADY_COMPLETED",
        "Task mutation already completed; the stored disposition prevents a second invocation.",
        record
      );
    }
    return taskError(
      "TASK_OPERATION_BLOCKED",
      "Task mutation has an incomplete or blocked durable disposition and will not be replayed automatically.",
      record
    );
  }
}

function sanitizeValidationCapture(capture: ValidationArtifactCapture): ValidationArtifactCapture {
  return {
    ...capture,
    commands: capture.commands.map((command) => ({
      ...command,
      stdout: redactHostPaths(command.stdout),
      stderr: redactHostPaths(command.stderr)
    }))
  };
}

function requireMutationBinding(input: Record<string, unknown>): {
  operationId: string;
  repoId: string;
  expectedHead: string;
  expectedTree: string;
} {
  const operationId = input.operation_id;
  const repoId = input.repo_id;
  const expectedHead = input.expected_head_sha;
  const expectedTree = input.expected_tree_sha;
  if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(operationId)) {
    throw new RepoReaderError("TASK_STATE_MISMATCH", "Task mutations require a stable operation_id.");
  }
  if (typeof repoId !== "string" || repoId.length === 0) {
    throw new RepoReaderError("TASK_STATE_MISMATCH", "Task mutations require a task-scoped repo_id.");
  }
  if (typeof expectedHead !== "string" || !/^[a-f0-9]{40}$/.test(expectedHead)) {
    throw new RepoReaderError("TASK_STATE_MISMATCH", "Task mutations require exact expected_head_sha.");
  }
  if (typeof expectedTree !== "string" || !/^[a-f0-9]{40}$/.test(expectedTree)) {
    throw new RepoReaderError("TASK_STATE_MISMATCH", "Task mutations require exact expected_tree_sha.");
  }
  return { operationId, repoId, expectedHead, expectedTree };
}

function digestResult(result: CallToolResult): string {
  const serialized = JSON.stringify(result);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_DIGEST_BYTES) {
    throw new RepoReaderError("TASK_OPERATION_BLOCKED", "Task mutation result exceeds the bounded digest envelope.");
  }
  return canonicalSha256(JSON.parse(serialized));
}

function jsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESULT_DIGEST_BYTES) {
    throw new RepoReaderError("TASK_STATE_MISMATCH", "Task mutation request exceeds the bounded idempotency envelope.");
  }
  return JSON.parse(serialized);
}

function stableFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,120}$/.test(code)) return code;
  }
  return "TASK_MUTATION_FAILED";
}

function taskError(
  code: "TASK_OPERATION_ALREADY_COMPLETED" | "TASK_OPERATION_BLOCKED" | "TASK_OPERATION_CONFLICT" | "TASK_STATE_MISMATCH",
  message: string,
  record?: TaskMutationRecord
): CallToolResult {
  return createErrorEnvelope(new RepoReaderError(code, message, {
    diagnostics: record ? {
      operation_id: record.operation_id,
      phase: record.phase,
      ...(record.result_sha256 ? { result_sha256: record.result_sha256 } : {})
    } : {}
  }));
}
