import {
  TaskArtifactStore,
  TaskRuntimeService,
  type BaseRepositoryLookup,
  type TaskRepositoryRegistrar
} from "../task-runtime/index.js";
import type { ExternalLifecycleRuntime } from "./repository-lifecycle-runtime.js";
import { DurableTaskMutationRuntime } from "./durable-task-mutation-runtime.js";
import { RepositoryLifecycleRuntime } from "./repository-lifecycle-runtime.js";
import type { RootRegistry } from "./root-registry.js";

export type LifecycleRuntimeBundle = {
  lifecycle: RepositoryLifecycleRuntime;
  tasks: TaskRuntimeService;
  artifacts: TaskArtifactStore;
  taskMutations: DurableTaskMutationRuntime;
};

export async function createLifecycleRuntimeBundle(
  registry: RootRegistry,
  external?: ExternalLifecycleRuntime
): Promise<LifecycleRuntimeBundle> {
  const baseRepositories: BaseRepositoryLookup = {
    async getBaseRepository(repoId) {
      const repo = registry.getBase(repoId);
      if (!repo.lifecycle) throw new Error(`Repository ${repoId} has no lifecycle policy.`);
      return {
        repo_id: repo.repo_id,
        root: repo.root,
        worktree_root: repo.lifecycle.worktree_root,
        require_clean_base: repo.lifecycle.require_clean_base,
        max_concurrent_tasks: repo.lifecycle.max_concurrent_tasks
      };
    }
  };
  const registrar: TaskRepositoryRegistrar = {
    async registerTaskRepository(registration) {
      await registry.registerTaskRepo({
        task_id: registration.task_id,
        task_repo_id: registration.repo_id,
        base_repo_id: registration.base_repo_id,
        authority: registration.authority,
        branch: registration.branch,
        worktree: registration.root
      });
    },
    async unregisterTaskRepository(repoId) {
      if (registry.taskBinding(repoId)) registry.unregisterTaskRepo(repoId);
    }
  };
  const tasks = new TaskRuntimeService({
    runtimeRoot: registry.runtimeRoot,
    baseRepositories,
    registrar
  });
  const artifacts = new TaskArtifactStore(tasks.states, tasks.locks, {
    maxArtifactBytes: 4 * 1024 * 1024,
    maxRangeBytes: 65_536
  });
  await tasks.initialize();
  await tasks.rehydrateOpenTaskRepositories({ limit: 10_000 });
  return {
    tasks,
    artifacts,
    taskMutations: new DurableTaskMutationRuntime(registry, tasks, artifacts),
    lifecycle: new RepositoryLifecycleRuntime(registry, tasks, artifacts, external)
  };
}
