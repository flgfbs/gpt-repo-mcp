import { canonicalSha256, hashedDiskKey } from "./canonical-json.js";
import {
  GitObjectIdSchema,
  TaskCleanupInputSchema,
  TaskCloseInputSchema,
  TaskIdSchema,
  TaskOpenInputSchema,
  type ObservedEffectState,
  type OperationKind,
  type OperationPhase,
  type OperationState,
  type TaskCleanupInput,
  type TaskCloseInput,
  type TaskOpenInput,
  type TaskState
} from "./contracts.js";
import { CrossProcessLockManager, type CrossProcessLockOptions } from "./cross-process-lock.js";
import { TaskRuntimeError } from "./errors.js";
import {
  GitTaskWorktreeService,
  type GitTaskBinding,
  type WorktreeObservation,
  type WorktreeStatus
} from "./git-worktree-service.js";
import { SecureRuntimeFs } from "./secure-runtime-fs.js";
import { TaskStateStore } from "./state-store.js";

export interface BaseRepositoryLookup {
  getBaseRepository(repoId: string): Promise<{
    repo_id: string;
    root: string;
    worktree_root: string;
    require_clean_base?: boolean;
    max_concurrent_tasks?: number;
  }>;
}

export interface TaskWorktreeServiceFactory {
  forWorktreeRoot(worktreeRoot: string): GitTaskWorktreeService;
}

export type TaskRepositoryRegistration = {
  repo_id: string;
  root: string;
  task_id: string;
  base_repo_id: string;
  authority: "inspect" | "implement" | "ship";
  branch: string;
};

export interface TaskRepositoryRegistrar {
  /** This method is an idempotent ensure operation and must not invoke a provider or network. */
  registerTaskRepository(registration: TaskRepositoryRegistration): Promise<void>;
  /** This method is an idempotent ensure operation and must preserve the base repository registration. */
  unregisterTaskRepository(repoId: string): Promise<void>;
}

export type TaskRuntimeServiceOptions = {
  runtimeRoot: string;
  baseRepositories: BaseRepositoryLookup;
  registrar: TaskRepositoryRegistrar;
  worktrees?: TaskWorktreeServiceFactory;
  lock?: CrossProcessLockOptions;
  now?: () => Date;
};

export type TaskOpenResult = {
  repo_id: string;
  task: TaskState;
  operation: OperationState;
  recovered_from_readback: boolean;
};

export type TaskStatusResult = {
  repo_id: string;
  task: TaskState;
  observed_worktree: WorktreeObservation;
  git_status: WorktreeStatus | null;
};

export type TaskCleanupResult = {
  repo_id: string;
  task: TaskState;
  operation: OperationState;
  branch_deleted: boolean;
  branch_preserved: boolean;
};

export type TaskRegistrationRehydrationResult = {
  registered: TaskRepositoryRegistration[];
  skipped_task_ids: string[];
};

export type ExactTaskMutationState = {
  task: TaskState;
  head: string;
  tree: string;
  clean: boolean;
};

const NO_REPLAY_PHASES = new Set<OperationPhase>([
  "EXTERNAL_CONTACTED",
  "EXTERNAL_PRECONTACT",
  "EXTERNAL_SUCCEEDED",
  "FAILED_PRECONTACT",
  "FAILED_KNOWN_AFTER_CONTACT",
  "UNKNOWN_AFTER_CONTACT",
  "ROLLBACK_COMPLETE",
  "BLOCKED"
]);

export class TaskRuntimeService {
  readonly fs: SecureRuntimeFs;
  readonly states: TaskStateStore;
  readonly locks: CrossProcessLockManager;
  private readonly now: () => Date;
  private readonly worktrees: TaskWorktreeServiceFactory;

  constructor(private readonly options: TaskRuntimeServiceOptions) {
    this.fs = new SecureRuntimeFs(options.runtimeRoot);
    this.states = new TaskStateStore(this.fs);
    this.locks = new CrossProcessLockManager(this.fs, options.lock);
    this.now = options.now ?? (() => new Date());
    this.worktrees = options.worktrees ?? {
      forWorktreeRoot: (worktreeRoot) => new GitTaskWorktreeService(worktreeRoot)
    };
  }

  async initialize(): Promise<void> {
    await this.states.initialize();
  }

  async open(rawInput: TaskOpenInput): Promise<TaskOpenResult> {
    const input = TaskOpenInputSchema.parse(rawInput);
    await this.initialize();
    return this.locks.withLock(`repo-open:${input.base_repo_id}`, async () => (
      this.locks.withLock(`task:${input.task_id}`, async () => this.openLocked(input))
    ));
  }

  async status(taskId: string): Promise<TaskStatusResult> {
    await this.initialize();
    const parsedTaskId = TaskIdSchema.parse(taskId);
    return this.locks.withLock(`task:${parsedTaskId}`, async () => {
      const task = await this.states.requireTask(parsedTaskId);
      const { git, binding } = await this.bindingForTask(task);
      const observed = await git.inspect(binding);
      const gitStatus = observed.disposition === "EXACT" ? await git.status(binding) : null;
      return { repo_id: task.repo_id, task, observed_worktree: observed, git_status: gitStatus };
    });
  }

  async listTasks(options: { limit?: number } = {}): Promise<TaskState[]> {
    await this.initialize();
    return this.states.listTasks(options);
  }

  async rehydrateOpenTaskRepositories(options: { limit?: number } = {}): Promise<TaskRegistrationRehydrationResult> {
    await this.initialize();
    const discovered = await this.states.listTasks(options);
    const registered: TaskRepositoryRegistration[] = [];
    const skippedTaskIds: string[] = [];
    for (const discoveredTask of discovered) {
      if (discoveredTask.lifecycle !== "OPEN" || discoveredTask.close_disposition !== null) {
        skippedTaskIds.push(discoveredTask.task_id);
        continue;
      }
      await this.locks.withLock(`task:${discoveredTask.task_id}`, async () => {
        const task = await this.states.requireTask(discoveredTask.task_id);
        if (task.lifecycle !== "OPEN" || task.close_disposition !== null) {
          skippedTaskIds.push(task.task_id);
          return;
        }
        const { git, binding } = await this.bindingForTask(task);
        const observation = await git.inspect(binding);
        if (observation.disposition !== "EXACT") throw uncertainOpen(observation);
        const registeredTask = await this.ensureRegistered(task);
        registered.push(registrationFor(registeredTask));
      });
    }
    return { registered, skipped_task_ids: skippedTaskIds };
  }

  async runWithExactTaskState<T>(input: {
    task_id: string;
    expected_head: string;
    expected_tree: string;
  }, action: (before: ExactTaskMutationState) => Promise<T>): Promise<{
    result: T;
    before: ExactTaskMutationState;
    after: ExactTaskMutationState;
  }> {
    await this.initialize();
    const taskId = TaskIdSchema.parse(input.task_id);
    const expectedHead = GitObjectIdSchema.parse(input.expected_head);
    const expectedTree = GitObjectIdSchema.parse(input.expected_tree);
    return this.locks.withLock(`task:${taskId}`, async () => {
      let task = await this.states.requireTask(taskId);
      if (task.lifecycle !== "OPEN" || task.registration_state !== "REGISTERED" || task.close_disposition !== null) {
        throw new TaskRuntimeError("TASK_NOT_OPEN", "Task mutations require an open, registered task worktree.", {
          lifecycle: task.lifecycle,
          registration_state: task.registration_state
        });
      }
      const beforeStatus = await this.observeExactTask(task);
      if (beforeStatus.head !== expectedHead || beforeStatus.tree !== expectedTree) {
        throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Task mutation expected HEAD or tree is stale.", {
          expected_head: expectedHead,
          expected_tree: expectedTree,
          observed_head: beforeStatus.head,
          observed_tree: beforeStatus.tree
        });
      }
      const before = { task, ...beforeStatus };
      let result: T;
      try {
        result = await action(before);
      } catch (error) {
        await this.refreshTaskGitBinding(task).catch(() => undefined);
        throw error;
      }
      task = await this.refreshTaskGitBinding(task);
      const afterStatus = await this.observeExactTask(task);
      return { result, before, after: { task, ...afterStatus } };
    });
  }

  async close(rawInput: TaskCloseInput): Promise<{ repo_id: string; task: TaskState; operation: OperationState }> {
    const input = TaskCloseInputSchema.parse(rawInput);
    await this.initialize();
    return this.locks.withLock(`task:${input.task_id}`, async () => {
      let operation = await this.ensureOperation("CLOSE", input.task_id, input.operation_id, input);
      if (operation.phase === "LOCAL_MUTATION_COMPLETE") {
        const task = await this.states.requireTask(input.task_id);
        return { repo_id: task.repo_id, task, operation };
      }
      rejectNoReplay(operation);
      let task = await this.states.requireTask(input.task_id);
      if (task.close_disposition !== null && task.close_disposition !== input.disposition) {
        throw new TaskRuntimeError("TASK_BINDING_CONFLICT", "A durable close disposition cannot be replaced.", {
          persisted_disposition: task.close_disposition,
          requested_disposition: input.disposition
        });
      }
      if (["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "CLEANED"].includes(task.lifecycle)) {
        if (task.lifecycle === "CLEANED") {
          assertPersistedExpectedState(task, input.expected_head, input.expected_tree);
        } else {
          await this.verifyExpectedTaskState(task, input.expected_head, input.expected_tree);
        }
        if (operation.phase === "CREATED") operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");
        operation = await this.advance(operation, "LOCAL_MUTATION_COMPLETE", "ABSENT", { result_repo_id: task.repo_id });
        return { repo_id: task.repo_id, task, operation };
      }
      if (!["OPEN", "CLOSING", "CLOSED", "CLEANUP_BLOCKED", "RECOVERY_REQUIRED"].includes(task.lifecycle)) {
        throw new TaskRuntimeError("TASK_NOT_OPEN", "Task must be open before it can be closed.", { lifecycle: task.lifecycle });
      }
      const verified = await this.verifyExpectedTaskState(task, input.expected_head, input.expected_tree);
      if (verified) task = await this.writeTaskUpdate(task, { worktree_head: verified.head, worktree_tree: verified.tree });
      if (operation.phase === "CREATED") operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");
      if (operation.phase === "ADMITTED") operation = await this.advance(operation, "LOCAL_MUTATION_STARTED", "NOT_STARTED");
      task = await this.writeTaskUpdate(task, {
        lifecycle: "CLOSING",
        registration_state: "UNKNOWN",
        close_disposition: input.disposition,
        close_reason: input.reason
      });
      try {
        await this.options.registrar.unregisterTaskRepository(task.repo_id);
      } catch (error) {
        task = await this.writeTaskUpdate(task, { lifecycle: "RECOVERY_REQUIRED", registration_state: "UNKNOWN" });
        operation = await this.block(operation, "UNKNOWN", "REGISTRAR_UNREGISTER_FAILED", messageOf(error));
        throw blocked(operation);
      }
      task = await this.writeTaskUpdate(task, {
        lifecycle: "CLOSED",
        registration_state: "UNREGISTERED",
        close_disposition: input.disposition,
        closed_at: this.now().toISOString()
      });
      operation = await this.advance(operation, "LOCAL_MUTATION_COMPLETE", "PRESENT", { result_repo_id: task.repo_id });
      return { repo_id: task.repo_id, task, operation };
    });
  }

  async cleanup(rawInput: TaskCleanupInput): Promise<TaskCleanupResult> {
    const input = TaskCleanupInputSchema.parse(rawInput);
    await this.initialize();
    return this.locks.withLock(`task:${input.task_id}`, async () => {
      let operation = await this.ensureOperation("CLEANUP", input.task_id, input.operation_id, input);
      if (operation.phase === "LOCAL_MUTATION_COMPLETE") {
        const task = await this.states.requireTask(input.task_id);
        return cleanupResult(task, operation);
      }
      rejectNoReplay(operation);
      let task = await this.states.requireTask(input.task_id);
      if (task.lifecycle === "CLEANED") {
        assertPersistedExpectedState(task, input.expected_head, input.expected_tree);
        if (operation.phase === "CREATED") operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");
        operation = await this.advance(operation, "LOCAL_MUTATION_COMPLETE", "ABSENT", { result_repo_id: task.repo_id });
        return cleanupResult(task, operation);
      }
      if (task.close_disposition === null || task.closed_at === null) {
        throw new TaskRuntimeError("TASK_NOT_CLOSED", "Task cleanup requires a durable terminal close outcome.", {
          lifecycle: task.lifecycle
        });
      }
      if (!["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "RECOVERY_REQUIRED"].includes(task.lifecycle)) {
        throw new TaskRuntimeError("TASK_NOT_CLOSED", "Task cleanup requires a closed task.", { lifecycle: task.lifecycle });
      }
      await this.verifyExpectedTaskState(task, input.expected_head, input.expected_tree);
      if (operation.phase === "CREATED") operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");
      const { git, binding } = await this.bindingForTask(task);
      let observation = await git.inspect(binding);
      if (observation.disposition === "CONFLICT" || (observation.disposition === "PARTIAL" && observation.path_present)) {
        task = await this.writeTaskUpdate(task, { lifecycle: "RECOVERY_REQUIRED", worktree_state: observation.disposition });
        operation = await this.block(operation, observation.disposition === "CONFLICT" ? "UNKNOWN" : "PARTIAL", "WORKTREE_RECONCILIATION_REQUIRED", "Task worktree is conflicting or partially materialized.");
        throw blocked(operation);
      }
      if (operation.phase === "ADMITTED") operation = await this.advance(operation, "LOCAL_MUTATION_STARTED", observation.disposition === "ABSENT" ? "ABSENT" : "PRESENT");

      task = await this.writeTaskUpdate(task, { lifecycle: "CLEANUP_STARTED" });
      if (observation.disposition === "EXACT") {
        const status = await git.status(binding);
        if (!status.clean) {
          task = await this.writeTaskUpdate(task, { lifecycle: "CLEANUP_BLOCKED", worktree_state: "DIRTY", branch_state: "PRESERVED" });
          operation = await this.block(operation, "PRESENT", "GIT_WORKTREE_DIRTY", "Cleanup preserved a dirty task worktree.");
          throw blocked(operation);
        }
        task = await this.writeTaskUpdate(task, { worktree_head: status.head, worktree_tree: status.tree });
        await git.remove(binding);
        observation = await git.inspect(binding);
      }

      if (observation.path_present || observation.registered) {
        task = await this.writeTaskUpdate(task, { lifecycle: "RECOVERY_REQUIRED", worktree_state: "PARTIAL" });
        operation = await this.block(operation, "PARTIAL", "WORKTREE_REMOVE_UNCERTAIN", "Task worktree removal did not reach a known absent state.");
        throw blocked(operation);
      }

      let branchDeleted = false;
      let branchPreserved = false;
      if (observation.branch_present) {
        if (!task.worktree_head) {
          task = await this.writeTaskUpdate(task, { lifecycle: "RECOVERY_REQUIRED", worktree_state: "ABSENT", branch_state: "UNKNOWN" });
          operation = await this.block(operation, "PARTIAL", "BRANCH_HEAD_UNKNOWN", "Task branch exists but its expected head was not durably bound.");
          throw blocked(operation);
        }
        const deletion = await git.safeDeleteBranch(binding, task.worktree_head);
        branchDeleted = deletion.deleted;
        branchPreserved = deletion.reason === "NOT_MERGED";
      }

      task = await this.writeTaskUpdate(task, {
        lifecycle: "CLEANED",
        worktree_state: "ABSENT",
        branch_state: branchPreserved ? "PRESERVED" : "ABSENT",
        registration_state: "UNREGISTERED",
        cleanup_note: branchPreserved ? "Server-owned branch was preserved because Git did not consider it merged." : task.cleanup_note
      });
      operation = await this.advance(operation, "LOCAL_MUTATION_COMPLETE", "PRESENT", { result_repo_id: task.repo_id });
      return { repo_id: task.repo_id, task, operation, branch_deleted: branchDeleted, branch_preserved: branchPreserved };
    });
  }

  private async openLocked(input: TaskOpenInput): Promise<TaskOpenResult> {
    let operation = await this.ensureOperation("OPEN", input.task_id, input.operation_id, input);
    const existing = await this.states.readTask(input.task_id);
    if (operation.phase === "LOCAL_MUTATION_COMPLETE") {
      if (!existing) throw new TaskRuntimeError("TASK_STATE_TAMPERED", "Completed open operation has no task state.");
      assertTaskBinding(existing, input);
      if (isTerminalTask(existing)) {
        return { repo_id: existing.repo_id, task: existing, operation, recovered_from_readback: true };
      }
      const { git, binding } = await this.bindingForTask(existing);
      const observation = await git.inspect(binding);
      if (observation.disposition !== "EXACT") throw uncertainOpen(observation);
      const task = await this.ensureRegistered(existing);
      return { repo_id: task.repo_id, task, operation, recovered_from_readback: true };
    }
    rejectNoReplay(operation);
    if (operation.phase === "CREATED") operation = await this.advance(operation, "ADMITTED", "NOT_STARTED");
    if (existing && isTerminalTask(existing)) {
      operation = await this.block(operation, "ABSENT", "TASK_ALREADY_CLOSED", "A terminal task_id cannot be reopened with a new operation.");
      throw blocked(operation);
    }

    const base = await this.options.baseRepositories.getBaseRepository(input.base_repo_id);
    if (base.repo_id !== input.base_repo_id) {
      operation = await this.block(operation, "ABSENT", "BASE_REPOSITORY_ID_MISMATCH", "Base repository lookup returned a different repo_id.");
      throw blocked(operation);
    }
    const git = this.worktrees.forWorktreeRoot(base.worktree_root);
    const binding = git.binding({
      task_id: input.task_id,
      owner_root: base.root,
      base_branch: input.base_branch,
      base_commit: input.base_commit,
      base_tree: input.base_tree,
      branch_slug: input.branch_slug
    });
    if (base.require_clean_base === true) {
      await git.verifyBaseClean(binding);
    } else {
      await git.verifyBase(binding);
    }

    if (!existing) {
      const limit = base.max_concurrent_tasks ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
        throw new TaskRuntimeError("TASK_RUNTIME_INVALID", "max_concurrent_tasks must be an integer between 1 and 64.");
      }
      const active = (await this.states.listTasks({ limit: 10_000 })).filter((candidate) => (
        candidate.base_repo_id === input.base_repo_id
        && !["CLOSED", "CLEANED"].includes(candidate.lifecycle)
        && candidate.close_disposition === null
      ));
      if (active.length >= limit) {
        operation = await this.block(operation, "ABSENT", "TASK_CAPACITY_REACHED", "Repository task concurrency limit is reached.");
        throw blocked(operation);
      }
    }

    let task = existing;
    if (task) {
      assertTaskBinding(task, input);
      assertDerivedBinding(task, binding);
    } else {
      const timestamp = this.now().toISOString();
      task = await this.states.writeTask({
        schema_version: 1,
        task_id: input.task_id,
        repo_id: ephemeralRepoId(input.task_id, input.base_repo_id),
        base_repo_id: input.base_repo_id,
        base_branch: input.base_branch,
        base_commit: input.base_commit,
        base_tree: input.base_tree,
        authority: input.authority,
        goal: input.goal,
        branch_slug: input.branch_slug,
        server_branch: binding.server_branch,
        worktree_path: binding.worktree_path,
        lifecycle: "OPENING",
        worktree_state: "ABSENT",
        branch_state: "ABSENT",
        worktree_head: input.base_commit,
        worktree_tree: input.base_tree,
        registration_state: "PENDING",
        close_disposition: null,
        closed_at: null,
        revision: 0,
        created_at: timestamp,
        updated_at: timestamp
      });
    }

    let observation = await git.inspect(binding);
    const recovered = operation.phase === "LOCAL_MUTATION_STARTED" || observation.disposition === "EXACT";
    if (observation.disposition === "PARTIAL" || observation.disposition === "CONFLICT") {
      task = await this.writeTaskUpdate(task, {
        lifecycle: "RECOVERY_REQUIRED",
        worktree_state: observation.disposition,
        branch_state: observation.branch_present ? "PRESENT" : "UNKNOWN"
      });
      operation = await this.block(operation, observation.disposition === "PARTIAL" ? "PARTIAL" : "UNKNOWN", "WORKTREE_RECONCILIATION_REQUIRED", "Open operation found a partial or conflicting task worktree.");
      throw blocked(operation);
    }

    if (operation.phase === "ADMITTED") operation = await this.advance(operation, "LOCAL_MUTATION_STARTED", observation.disposition === "ABSENT" ? "ABSENT" : "PRESENT");
    if (observation.disposition === "ABSENT") {
      try {
        observation = await git.create(binding);
      } catch (error) {
        const after = await this.inspectAfterFailure(git, binding);
        if (after.disposition === "EXACT") {
          observation = after;
        } else {
          const effect: ObservedEffectState = after.disposition === "ABSENT" ? "ABSENT" : after.disposition === "PARTIAL" ? "PARTIAL" : "UNKNOWN";
          task = await this.writeTaskUpdate(task, {
            lifecycle: effect === "ABSENT" ? "OPENING" : "RECOVERY_REQUIRED",
            worktree_state: after.disposition,
            branch_state: after.branch_present ? "PRESENT" : "UNKNOWN"
          });
          operation = await this.block(operation, effect, "WORKTREE_CREATE_FAILED", messageOf(error));
          throw blocked(operation);
        }
      }
    }
    if (observation.disposition !== "EXACT") throw uncertainOpen(observation);
    task = await this.writeTaskUpdate(task, {
      lifecycle: "OPENING",
      worktree_state: "PRESENT",
      branch_state: "PRESENT",
      worktree_head: observation.observed_head,
      worktree_tree: observation.observed_tree,
      registration_state: "PENDING"
    });
    try {
      task = await this.ensureRegistered(task);
    } catch (error) {
      task = await this.writeTaskUpdate(task, { lifecycle: "RECOVERY_REQUIRED", registration_state: "UNKNOWN" });
      operation = await this.block(operation, "PRESENT", "REGISTRAR_REGISTER_FAILED", messageOf(error));
      throw blocked(operation);
    }
    operation = await this.advance(operation, "LOCAL_MUTATION_COMPLETE", "PRESENT", { result_repo_id: task.repo_id });
    return { repo_id: task.repo_id, task, operation, recovered_from_readback: recovered };
  }

  private async ensureRegistered(task: TaskState): Promise<TaskState> {
    await this.options.registrar.registerTaskRepository(registrationFor(task));
    if (task.registration_state === "REGISTERED" && task.lifecycle === "OPEN") return task;
    return this.writeTaskUpdate(task, { lifecycle: "OPEN", registration_state: "REGISTERED" });
  }

  private async verifyExpectedTaskState(
    task: TaskState,
    expectedHead?: string,
    expectedTree?: string
  ): Promise<WorktreeStatus | undefined> {
    if (expectedHead === undefined || expectedTree === undefined) return undefined;
    const { git, binding } = await this.bindingForTask(task);
    const observation = await git.inspect(binding);
    if (observation.disposition !== "EXACT") throw uncertainOpen(observation);
    const status = await git.status(binding);
    if (status.head !== expectedHead) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Task HEAD changed before the exact lifecycle operation.", {
        expected_head: expectedHead,
        observed_head: status.head
      });
    }
    if (status.tree !== expectedTree) {
      throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Task tree changed before the exact lifecycle operation.", {
        expected_tree: expectedTree,
        observed_tree: status.tree
      });
    }
    return status;
  }

  private async observeExactTask(task: TaskState): Promise<Omit<ExactTaskMutationState, "task">> {
    const { git, binding } = await this.bindingForTask(task);
    const observation = await git.inspect(binding);
    if (observation.disposition !== "EXACT") throw uncertainOpen(observation);
    const status = await git.status(binding);
    return { head: status.head, tree: status.tree, clean: status.clean };
  }

  private async refreshTaskGitBinding(task: TaskState): Promise<TaskState> {
    const observed = await this.observeExactTask(task);
    if (task.worktree_head === observed.head && task.worktree_tree === observed.tree) return task;
    return this.writeTaskUpdate(task, { worktree_head: observed.head, worktree_tree: observed.tree });
  }

  private async bindingForTask(task: TaskState): Promise<{ git: GitTaskWorktreeService; binding: GitTaskBinding }> {
    const base = await this.options.baseRepositories.getBaseRepository(task.base_repo_id);
    if (base.repo_id !== task.base_repo_id) throw new TaskRuntimeError("TASK_BINDING_CONFLICT", "Base repository lookup identity changed.");
    const git = this.worktrees.forWorktreeRoot(base.worktree_root);
    const binding = git.binding({
      task_id: task.task_id,
      owner_root: base.root,
      base_branch: task.base_branch,
      base_commit: task.base_commit,
      base_tree: task.base_tree,
      branch_slug: task.branch_slug
    });
    assertDerivedBinding(task, binding);
    return { git, binding };
  }

  private async ensureOperation(kind: OperationKind, taskId: string, operationId: string, request: unknown): Promise<OperationState> {
    const requestSha = canonicalSha256({ schema_version: 1, kind, request });
    const existing = await this.states.readOperation(taskId, operationId);
    if (existing) {
      if (existing.kind !== kind || existing.request_sha256 !== requestSha) {
        throw new TaskRuntimeError("OPERATION_ID_CONFLICT", "operation_id is already bound to different canonical request bytes.");
      }
      return existing;
    }
    const timestamp = this.now().toISOString();
    return this.states.writeOperation({
      schema_version: 1,
      task_id: taskId,
      operation_id: operationId,
      kind,
      request_sha256: requestSha,
      phase: "CREATED",
      effect_state: "NOT_STARTED",
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      result_repo_id: null,
      error_code: null,
      error_message: null
    });
  }

  private async advance(
    operation: OperationState,
    phase: OperationPhase,
    effectState: ObservedEffectState,
    extras: { result_repo_id?: string } = {}
  ): Promise<OperationState> {
    const completed = phase === "LOCAL_MUTATION_COMPLETE" || phase === "EXTERNAL_SUCCEEDED" || phase === "ROLLBACK_COMPLETE";
    return this.states.writeOperation({
      ...operation,
      phase,
      effect_state: effectState,
      revision: operation.revision + 1,
      updated_at: this.now().toISOString(),
      completed_at: completed ? this.now().toISOString() : null,
      result_repo_id: extras.result_repo_id ?? operation.result_repo_id,
      error_code: null,
      error_message: null
    });
  }

  private async block(operation: OperationState, effectState: ObservedEffectState, code: string, message: string): Promise<OperationState> {
    return this.states.writeOperation({
      ...operation,
      phase: "BLOCKED",
      effect_state: effectState,
      revision: operation.revision + 1,
      updated_at: this.now().toISOString(),
      completed_at: this.now().toISOString(),
      error_code: code,
      error_message: message.slice(0, 1_000)
    });
  }

  private async writeTaskUpdate(task: TaskState, changes: Partial<Omit<TaskState, "schema_version" | "task_id" | "created_at" | "revision" | "updated_at" | "state_sha256">>): Promise<TaskState> {
    return this.states.writeTask({
      ...task,
      ...changes,
      revision: task.revision + 1,
      updated_at: this.now().toISOString()
    });
  }

  private async inspectAfterFailure(git: GitTaskWorktreeService, binding: GitTaskBinding): Promise<WorktreeObservation> {
    try {
      return await git.inspect(binding);
    } catch {
      return {
        disposition: "CONFLICT",
        path_present: false,
        registered: false,
        branch_present: false,
        observed_head: null,
        observed_tree: null,
        observed_branch: null
      };
    }
  }
}

export function ephemeralRepoId(taskId: string, baseRepoId: string): string {
  return `task-${hashedDiskKey("task-repository", `${taskId}\0${baseRepoId}`).slice(0, 40)}`;
}

function assertPersistedExpectedState(task: TaskState, expectedHead?: string, expectedTree?: string): void {
  if (expectedHead === undefined || expectedTree === undefined) return;
  if (task.worktree_head !== expectedHead || task.worktree_tree !== expectedTree) {
    throw new TaskRuntimeError("GIT_BINDING_MISMATCH", "Persisted terminal task state does not match the expected HEAD and tree.", {
      expected_head: expectedHead,
      expected_tree: expectedTree,
      persisted_head: task.worktree_head,
      persisted_tree: task.worktree_tree
    });
  }
}

function assertTaskBinding(task: TaskState, input: TaskOpenInput): void {
  const matches = task.base_repo_id === input.base_repo_id
    && task.base_branch === input.base_branch
    && task.base_commit === input.base_commit
    && task.base_tree === input.base_tree
    && task.authority === input.authority
    && task.goal === input.goal
    && task.branch_slug === input.branch_slug;
  if (!matches) throw new TaskRuntimeError("TASK_BINDING_CONFLICT", "task_id is already bound to different task-open inputs.");
}

function assertDerivedBinding(task: TaskState, binding: GitTaskBinding): void {
  if (task.server_branch !== binding.server_branch || task.worktree_path !== binding.worktree_path) {
    throw new TaskRuntimeError("TASK_BINDING_CONFLICT", "Persisted task path or branch does not match configured roots and derived identity.");
  }
}

function rejectNoReplay(operation: OperationState): void {
  if (NO_REPLAY_PHASES.has(operation.phase) || operation.effect_state === "PARTIAL" || operation.effect_state === "UNKNOWN") {
    throw blocked(operation);
  }
}

function blocked(operation: OperationState): TaskRuntimeError {
  return new TaskRuntimeError("OPERATION_BLOCKED", "Operation cannot be blindly replayed; inspect durable state before a separately authorized recovery.", {
    task_id: operation.task_id,
    operation_id: operation.operation_id,
    phase: operation.phase,
    effect_state: operation.effect_state,
    error_code: operation.error_code
  });
}

function uncertainOpen(observation: WorktreeObservation): TaskRuntimeError {
  return new TaskRuntimeError("GIT_EFFECT_UNCERTAIN", "Task worktree readback is not exact; open will not replay the Git mutation.", observation);
}

function cleanupResult(task: TaskState, operation: OperationState): TaskCleanupResult {
  return {
    repo_id: task.repo_id,
    task,
    operation,
    branch_deleted: task.branch_state === "ABSENT",
    branch_preserved: task.branch_state === "PRESERVED"
  };
}

function isTerminalTask(task: TaskState): boolean {
  return task.close_disposition !== null || ["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "CLEANED"].includes(task.lifecycle);
}

function registrationFor(task: TaskState): TaskRepositoryRegistration {
  return {
    repo_id: task.repo_id,
    root: task.worktree_path,
    task_id: task.task_id,
    base_repo_id: task.base_repo_id,
    authority: task.authority,
    branch: task.server_branch
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown task runtime failure.";
}
