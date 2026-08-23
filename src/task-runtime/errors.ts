export type TaskRuntimeErrorCode =
  | "TASK_RUNTIME_INVALID"
  | "TASK_STATE_NOT_FOUND"
  | "TASK_STATE_TAMPERED"
  | "TASK_BINDING_CONFLICT"
  | "TASK_NOT_OPEN"
  | "TASK_NOT_CLOSED"
  | "OPERATION_ID_CONFLICT"
  | "OPERATION_BLOCKED"
  | "LOCK_TIMEOUT"
  | "RUNTIME_PATH_UNSAFE"
  | "RUNTIME_FILE_UNSAFE"
  | "RUNTIME_SIZE_LIMIT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_SECRET_BLOCKED"
  | "ARTIFACT_TYPE_BLOCKED"
  | "ARTIFACT_RANGE_INVALID"
  | "GIT_BINDING_MISMATCH"
  | "GIT_WORKTREE_CONFLICT"
  | "GIT_WORKTREE_DIRTY"
  | "GIT_EFFECT_UNCERTAIN";

export class TaskRuntimeError extends Error {
  readonly code: TaskRuntimeErrorCode;
  readonly diagnostics: Readonly<Record<string, unknown>>;

  constructor(code: TaskRuntimeErrorCode, message: string, diagnostics: Record<string, unknown> = {}) {
    super(message);
    this.name = "TaskRuntimeError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
