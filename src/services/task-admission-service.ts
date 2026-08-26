import {
  RepoTaskAdmissionInputSchema,
  RepoTaskAdmissionResultSchema,
  type RepoTaskAdmissionInput,
  type RepoTaskAdmissionResult,
  type TaskAdmissionCandidate,
  type TaskAdmissionState,
  type TaskAdmissionConflictReason
} from "../contracts/task-admission.contract.js";
import { canonicalSha256, type TaskRuntimeService, type TaskState } from "../task-runtime/index.js";
import type { RootRegistry } from "./root-registry.js";
import type { DelegationRunRecord } from "../delegation/run-store.js";

export type DelegationRunTaskAdmission =
  | {
      admission: "matching_active_task";
      expected_binding_sha256: string;
      task: Extract<TaskAdmissionState, { status: "matching_active_task" }>["task"];
      worktree_clean: boolean;
    }
  | {
      admission: "task_absent" | "conflicting_active_task";
      reason: string;
    };

const TERMINAL_LIFECYCLES = new Set(["CLOSED", "CLEANUP_STARTED", "CLEANUP_BLOCKED", "CLEANED"]);
const MAX_PUBLIC_CANDIDATES = 20;

export class TaskAdmissionService {
  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService
  ) {}

  async read(rawInput: RepoTaskAdmissionInput): Promise<RepoTaskAdmissionResult> {
    const input = RepoTaskAdmissionInputSchema.parse(rawInput);
    const base = this.registry.getBase(input.repo_id);
    const lifecycleAvailable = base.lifecycle !== undefined;
    const expectedBindingSha256 = canonicalSha256({
      repo_id: input.repo_id,
      task_id: input.task_id,
      ...input.expected
    });
    const repositoryTasks = (await this.tasks.listTasks({ limit: 10_000 }))
      .filter((task) => task.base_repo_id === input.repo_id)
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
    const activeTasks = repositoryTasks.filter(isActiveTask);

    if (activeTasks.length === 0) {
      const terminal = repositoryTasks.find((task) => task.task_id === input.task_id);
      return RepoTaskAdmissionResultSchema.parse({
        ok: true,
        repo_id: input.repo_id,
        task_id: input.task_id,
        expected_binding_sha256: expectedBindingSha256,
        lifecycle_available: lifecycleAvailable,
        admission: {
          status: "task_absent",
          absence_reason: terminal ? "TERMINAL_TASK_ID" : "NO_TASK",
          active_task_count: 0,
          ...(terminal ? { terminal_task: candidateSummary(terminal) } : {})
        },
        warnings: lifecycleAvailable ? [] : ["LIFECYCLE_POLICY_UNAVAILABLE"]
      });
    }

    const candidate = activeTasks.find((task) => task.task_id === input.task_id);
    const reasons = new Set<TaskAdmissionConflictReason>();
    if (!candidate) reasons.add("OTHER_ACTIVE_TASK");
    if (activeTasks.length !== 1) reasons.add("MULTIPLE_ACTIVE_TASKS");

    if (candidate) {
      if (candidate.lifecycle !== "OPEN" || candidate.registration_state !== "REGISTERED" || candidate.close_disposition !== null) {
        reasons.add("TASK_NOT_READY");
      }
      const registration = this.registry.taskBinding(candidate.repo_id);
      if (
        !registration
        || registration.task_id !== candidate.task_id
        || registration.task_repo_id !== candidate.repo_id
        || registration.base_repo_id !== candidate.base_repo_id
        || registration.authority !== candidate.authority
        || registration.branch !== candidate.server_branch
      ) {
        reasons.add("TASK_REGISTRATION_MISMATCH");
      }
      if (!matchesPersistedBinding(candidate, input)) reasons.add("TASK_BINDING_MISMATCH");
    }

    if (candidate && reasons.size === 0) {
      try {
        const status = await this.tasks.status(candidate.task_id);
        const exact = status.observed_worktree.disposition === "EXACT" ? status.git_status : null;
        if (!exact) {
          reasons.add("TASK_READBACK_UNAVAILABLE");
        } else if (exact.head !== input.expected.head_sha || exact.tree !== input.expected.tree_sha) {
          reasons.add("TASK_HEAD_TREE_MISMATCH");
        } else {
          return RepoTaskAdmissionResultSchema.parse({
            ok: true,
            repo_id: input.repo_id,
            task_id: input.task_id,
            expected_binding_sha256: expectedBindingSha256,
            lifecycle_available: lifecycleAvailable,
            admission: {
              status: "matching_active_task",
              active_task_count: 1,
              task: candidateSummary(status.task, exact.head, exact.tree),
              worktree_clean: exact.clean
            },
            warnings: []
          });
        }
      } catch {
        reasons.add("TASK_READBACK_UNAVAILABLE");
      }
    }

    const observedTasks = activeTasks.slice(0, MAX_PUBLIC_CANDIDATES).map((task) => candidateSummary(task));
    return RepoTaskAdmissionResultSchema.parse({
      ok: true,
      repo_id: input.repo_id,
      task_id: input.task_id,
      expected_binding_sha256: expectedBindingSha256,
      lifecycle_available: lifecycleAvailable,
      admission: {
        status: "conflicting_active_task",
        active_task_count: activeTasks.length,
        conflict_reasons: [...reasons].sort(),
        observed_tasks: observedTasks,
        truncated: activeTasks.length > observedTasks.length
      },
      warnings: lifecycleAvailable ? [] : ["LIFECYCLE_POLICY_UNAVAILABLE"]
    });
  }

  async readForDelegationRun(run: DelegationRunRecord): Promise<DelegationRunTaskAdmission> {
    if (run.manifest.schema_version !== 3) {
      return { admission: "conflicting_active_task", reason: "UNSUPPORTED_MANIFEST_VERSION" };
    }
    const registration = this.registry.taskBinding(run.repo_id);
    if (!registration) {
      return { admission: "task_absent", reason: "TASK_REPOSITORY_NOT_REGISTERED" };
    }
    const task = (await this.tasks.listTasks({ limit: 10_000 }))
      .find((candidate) => candidate.task_id === registration.task_id);
    if (!task) {
      return { admission: "task_absent", reason: "TASK_STATE_NOT_FOUND" };
    }
    if (task.repo_id !== run.repo_id || task.worktree_tree === null) {
      return { admission: "conflicting_active_task", reason: "TASK_REPOSITORY_BINDING_MISMATCH" };
    }
    const result = await this.read({
      repo_id: task.base_repo_id,
      task_id: task.task_id,
      expected: {
        base_branch: task.base_branch,
        base_commit_sha: task.base_commit,
        base_tree_sha: task.base_tree,
        authority: task.authority,
        goal_sha256: canonicalSha256(task.goal),
        branch_slug: task.branch_slug,
        head_sha: run.manifest.baseline.head_sha,
        tree_sha: task.worktree_tree
      }
    });
    const admission = result.admission;
    if (admission.status === "matching_active_task") {
      if (admission.task.task_repo_id !== run.repo_id) {
        return { admission: "conflicting_active_task", reason: "TASK_REPOSITORY_BINDING_MISMATCH" };
      }
      return {
        admission: "matching_active_task",
        expected_binding_sha256: result.expected_binding_sha256,
        task: admission.task,
        worktree_clean: admission.worktree_clean
      };
    }
    if (admission.status === "task_absent") {
      return { admission: "task_absent", reason: admission.absence_reason };
    }
    return {
      admission: "conflicting_active_task",
      reason: admission.conflict_reasons.join("+")
    };
  }
}

function isActiveTask(task: TaskState): boolean {
  return !TERMINAL_LIFECYCLES.has(task.lifecycle);
}

function matchesPersistedBinding(task: TaskState, input: RepoTaskAdmissionInput): boolean {
  return task.base_repo_id === input.repo_id
    && task.task_id === input.task_id
    && task.base_branch === input.expected.base_branch
    && task.base_commit === input.expected.base_commit_sha
    && task.base_tree === input.expected.base_tree_sha
    && task.authority === input.expected.authority
    && canonicalSha256(task.goal) === input.expected.goal_sha256
    && task.branch_slug === input.expected.branch_slug;
}

function candidateSummary(task: TaskState, head = task.worktree_head, tree = task.worktree_tree): TaskAdmissionCandidate {
  return {
    task_id: task.task_id,
    task_repo_id: task.repo_id,
    base_repo_id: task.base_repo_id,
    lifecycle: task.lifecycle.toLowerCase() as TaskAdmissionCandidate["lifecycle"],
    registration_state: task.registration_state.toLowerCase() as TaskAdmissionCandidate["registration_state"],
    authority: task.authority,
    head_sha: head,
    tree_sha: tree,
    binding_sha256: canonicalSha256({
      task_id: task.task_id,
      task_repo_id: task.repo_id,
      base_repo_id: task.base_repo_id,
      base_branch: task.base_branch,
      base_commit_sha: task.base_commit,
      base_tree_sha: task.base_tree,
      authority: task.authority,
      goal_sha256: canonicalSha256(task.goal),
      branch_slug: task.branch_slug,
      task_branch: task.server_branch,
      head_sha: head,
      tree_sha: tree
    }),
    state_sha256: task.state_sha256
  };
}
