import { describe, expect, test } from "vitest";
import type { RootRegistry } from "../src/services/root-registry.js";
import { TaskAdmissionService } from "../src/services/task-admission-service.js";
import { canonicalSha256, type TaskRuntimeService, type TaskState } from "../src/task-runtime/index.js";

const HEAD = "1".repeat(40);
const TREE = "2".repeat(40);
const BASE_HEAD = "3".repeat(40);
const BASE_TREE = "4".repeat(40);
const TASK_ID = "aidcp-runtime-task";
const TASK_REPO_ID = `task-${"5".repeat(40)}`;
const BASE_REPO_ID = "fixture-base";
const GOAL = "Resolve one bounded external execution-runtime dependency.";

const expected = {
  base_branch: "main",
  base_commit_sha: BASE_HEAD,
  base_tree_sha: BASE_TREE,
  authority: "implement" as const,
  goal_sha256: canonicalSha256(GOAL),
  branch_slug: "aidcp-runtime",
  head_sha: HEAD,
  tree_sha: TREE
};

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    schema_version: 1,
    task_id: TASK_ID,
    repo_id: TASK_REPO_ID,
    base_repo_id: BASE_REPO_ID,
    base_branch: "main",
    base_commit: BASE_HEAD,
    base_tree: BASE_TREE,
    authority: "implement",
    goal: GOAL,
    branch_slug: "aidcp-runtime",
    server_branch: `chat-pro/tasks/aidcp-runtime-${"6".repeat(12)}`,
    worktree_path: "/tmp/chat-pro-task-fixture",
    lifecycle: "OPEN",
    worktree_state: "PRESENT",
    branch_state: "PRESENT",
    worktree_head: HEAD,
    worktree_tree: TREE,
    registration_state: "REGISTERED",
    close_disposition: null,
    closed_at: null,
    revision: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    state_sha256: "7".repeat(64),
    ...overrides
  };
}

function registry(options: { lifecycle?: boolean; registeredTask?: TaskState } = {}): RootRegistry {
  const registered = options.registeredTask;
  return {
    getBase(repoId: string) {
      if (repoId !== BASE_REPO_ID) throw new Error("unexpected repo");
      return { repo_id: repoId, lifecycle: options.lifecycle === false ? undefined : {} };
    },
    taskBinding(repoId: string) {
      if (!registered || repoId !== registered.repo_id) return undefined;
      return {
        task_id: registered.task_id,
        task_repo_id: registered.repo_id,
        base_repo_id: registered.base_repo_id,
        authority: registered.authority,
        branch: registered.server_branch,
        worktree: registered.worktree_path
      };
    }
  } as unknown as RootRegistry;
}

function runtime(states: TaskState[], statusTask = states[0]): TaskRuntimeService {
  return {
    async listTasks() {
      return states;
    },
    async status(taskId: string) {
      if (!statusTask || statusTask.task_id !== taskId) throw new Error("task unavailable");
      return {
        repo_id: statusTask.repo_id,
        task: statusTask,
        observed_worktree: {
          disposition: "EXACT" as const,
          path_present: true,
          registered: true,
          branch_present: true,
          observed_head: statusTask.worktree_head,
          observed_tree: statusTask.worktree_tree,
          observed_branch: statusTask.server_branch
        },
        git_status: {
          clean: true,
          porcelain_z: "",
          changed_entry_count: 0,
          head: statusTask.worktree_head!,
          tree: statusTask.worktree_tree!,
          branch: statusTask.server_branch
        }
      };
    }
  } as unknown as TaskRuntimeService;
}

function input() {
  return { repo_id: BASE_REPO_ID, task_id: TASK_ID, expected };
}

describe("TaskAdmissionService", () => {
  test("returns a typed absent state without creating a task", async () => {
    const result = await new TaskAdmissionService(registry(), runtime([])).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "task_absent",
        absence_reason: "NO_TASK",
        active_task_count: 0
      },
      lifecycle_available: true,
      warnings: []
    });
  });

  test("returns an exact matching active task only after registered Git readback", async () => {
    const active = task();
    const result = await new TaskAdmissionService(registry({ registeredTask: active }), runtime([active])).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "matching_active_task",
        active_task_count: 1,
        worktree_clean: true,
        task: {
          task_id: TASK_ID,
          task_repo_id: TASK_REPO_ID,
          lifecycle: "open",
          registration_state: "registered",
          head_sha: HEAD,
          tree_sha: TREE
        }
      }
    });
  });

  test("admits an exact matching task alongside unrelated active tasks", async () => {
    const active = task();
    const unrelated = task({
      task_id: "unrelated-task",
      repo_id: `task-${"8".repeat(40)}`,
      branch_slug: "unrelated-task",
      server_branch: `chat-pro/tasks/unrelated-task-${"9".repeat(12)}`,
      worktree_path: "/tmp/chat-pro-unrelated-task",
      state_sha256: "a".repeat(64)
    });
    const result = await new TaskAdmissionService(
      registry({ registeredTask: active }),
      runtime([unrelated, active], active)
    ).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "matching_active_task",
        active_task_count: 2,
        worktree_clean: true,
        task: {
          task_id: TASK_ID,
          task_repo_id: TASK_REPO_ID,
          head_sha: HEAD,
          tree_sha: TREE
        }
      }
    });
  });

  test("still rejects a mismatched requested-task binding alongside unrelated active tasks", async () => {
    const active = task();
    const unrelated = task({
      task_id: "unrelated-task",
      repo_id: `task-${"8".repeat(40)}`,
      branch_slug: "unrelated-task"
    });
    const result = await new TaskAdmissionService(
      registry({ registeredTask: active }),
      runtime([unrelated, active], active)
    ).read({
      ...input(),
      expected: { ...expected, authority: "ship" }
    });
    expect(result).toMatchObject({
      admission: {
        status: "conflicting_active_task",
        active_task_count: 2,
        conflict_reasons: ["TASK_BINDING_MISMATCH"]
      }
    });
  });

  test("reports multiple unrelated active tasks when the requested task is absent", async () => {
    const first = task({
      task_id: "other-task-one",
      repo_id: `task-${"8".repeat(40)}`,
      branch_slug: "other-task-one"
    });
    const second = task({
      task_id: "other-task-two",
      repo_id: `task-${"9".repeat(40)}`,
      branch_slug: "other-task-two"
    });
    const result = await new TaskAdmissionService(
      registry({ registeredTask: first }),
      runtime([first, second], first)
    ).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "conflicting_active_task",
        active_task_count: 2,
        conflict_reasons: ["MULTIPLE_ACTIVE_TASKS", "OTHER_ACTIVE_TASK"]
      }
    });
  });

  test("reports another active task as a conflict instead of absence", async () => {
    const other = task({ task_id: "other-task", repo_id: `task-${"8".repeat(40)}` });
    const result = await new TaskAdmissionService(registry({ registeredTask: other }), runtime([other])).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "conflicting_active_task",
        active_task_count: 1,
        conflict_reasons: ["OTHER_ACTIVE_TASK"]
      }
    });
  });

  test("fails closed when current HEAD or tree differs from the expected admission", async () => {
    const active = task();
    const result = await new TaskAdmissionService(registry({ registeredTask: active }), runtime([active])).read({
      ...input(),
      expected: { ...expected, head_sha: "9".repeat(40) }
    });
    expect(result).toMatchObject({
      admission: {
        status: "conflicting_active_task",
        conflict_reasons: ["TASK_HEAD_TREE_MISMATCH"]
      }
    });
  });

  test("distinguishes a terminal task-id collision from an active conflict", async () => {
    const terminal = task({
      lifecycle: "CLOSED",
      worktree_state: "PRESENT",
      registration_state: "UNREGISTERED",
      close_disposition: "blocked",
      closed_at: "2026-08-26T01:00:00.000Z"
    });
    const result = await new TaskAdmissionService(registry(), runtime([terminal])).read(input());
    expect(result).toMatchObject({
      admission: {
        status: "task_absent",
        absence_reason: "TERMINAL_TASK_ID",
        active_task_count: 0,
        terminal_task: { task_id: TASK_ID, lifecycle: "closed" }
      }
    });
  });

  test("reports lifecycle unavailability without converting it into authority", async () => {
    const result = await new TaskAdmissionService(registry({ lifecycle: false }), runtime([])).read(input());
    expect(result).toMatchObject({
      admission: { status: "task_absent" },
      lifecycle_available: false,
      warnings: ["LIFECYCLE_POLICY_UNAVAILABLE"]
    });
  });
});
