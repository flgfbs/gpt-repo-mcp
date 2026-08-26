import {
  TaskArtifactStore,
  TaskRuntimeService,
  type BaseRepositoryLookup,
  type TaskRepositoryRegistrar
} from "../task-runtime/index.js";
import { InstalledGhJsonRunner } from "../github/gh-json-runner.js";
import { ProductionGitHubAdapter } from "../github/github-adapter.js";
import { OwnerApprovalStore } from "../github/owner-approval-store.js";
import { systemClock } from "../github/types.js";
import type { ExternalLifecycleRuntime } from "./repository-lifecycle-runtime.js";
import { DurableTaskMutationRuntime } from "./durable-task-mutation-runtime.js";
import { GitRemoteService, InstalledGitRunner, ProductionExactGitBoundary } from "./git-remote-service.js";
import { GitHubCiService } from "./github-ci-service.js";
import { GitHubLifecycleRuntime } from "./github-lifecycle-runtime.js";
import { GitHubMergeGateService } from "./github-merge-gate-service.js";
import { GitHubMergeService } from "./github-merge-service.js";
import { GitHubPostMergeService } from "./github-post-merge-service.js";
import { GitHubPrService } from "./github-pr-service.js";
import { GitHubReviewService } from "./github-review-service.js";
import {
  DurableGitHubOperationLedger,
  RegistryTaskLookup,
  TaskArtifactGitHubSink,
  TaskArtifactMergeEvidenceProvider
} from "./github-runtime-adapters.js";
import { RepositoryLifecycleRuntime } from "./repository-lifecycle-runtime.js";
import { DelegationExecutionRuntime } from "./delegation-execution-runtime.js";
import type { RootRegistry } from "./root-registry.js";

export type LifecycleRuntimeBundle = {
  lifecycle: RepositoryLifecycleRuntime;
  tasks: TaskRuntimeService;
  artifacts: TaskArtifactStore;
  taskMutations: DurableTaskMutationRuntime;
  executionRuntime: DelegationExecutionRuntime;
  github?: ProductionGitHubRuntimeBundle;
};

export type ProductionGitHubRuntimeBundle = {
  external: GitHubLifecycleRuntime;
  approvals: OwnerApprovalStore;
  gates: GitHubMergeGateService;
  taskLookup: RegistryTaskLookup;
  githubArtifacts: TaskArtifactGitHubSink;
  ledger: DurableGitHubOperationLedger;
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
  const executionRuntime = new DelegationExecutionRuntime(registry, tasks);
  const production = external
    ? undefined
    : await createProductionGitHubRuntimeBundle(registry, tasks, artifacts);
  const externalRuntime = external ?? production!.external;
  return {
    tasks,
    artifacts,
    taskMutations: new DurableTaskMutationRuntime(registry, tasks, artifacts),
    executionRuntime,
    lifecycle: new RepositoryLifecycleRuntime(registry, tasks, artifacts, externalRuntime),
    ...(production ? { github: production } : {})
  };
}

export async function createProductionGitHubRuntimeBundle(
  registry: RootRegistry,
  tasks: TaskRuntimeService,
  artifacts: TaskArtifactStore
): Promise<ProductionGitHubRuntimeBundle> {
  const taskLookup = new RegistryTaskLookup(registry, tasks);
  const ledger = new DurableGitHubOperationLedger(tasks.fs, tasks.locks);
  await ledger.initialize();
  const githubArtifacts = new TaskArtifactGitHubSink(taskLookup, artifacts, tasks.fs, tasks.locks);
  const git = new ProductionExactGitBoundary(new InstalledGitRunner(process.env));
  const github = new ProductionGitHubAdapter(new InstalledGhJsonRunner(registry.runtimeRoot, process.env));
  const remote = new GitRemoteService(taskLookup, git, github, githubArtifacts, ledger, systemClock);
  const pullRequests = new GitHubPrService(taskLookup, git, github, githubArtifacts, ledger, systemClock);
  const ci = new GitHubCiService(taskLookup, git, github, githubArtifacts, ledger, systemClock);
  const evidence = new TaskArtifactMergeEvidenceProvider(artifacts, git, github, githubArtifacts);
  const reviews = new GitHubReviewService(taskLookup, git, github, evidence, githubArtifacts, ledger, systemClock);
  const gates = new GitHubMergeGateService(
    taskLookup,
    git,
    github,
    ci,
    evidence,
    githubArtifacts,
    ledger,
    systemClock
  );
  const approvals = new OwnerApprovalStore(
    { getRuntimeRoot: async () => registry.runtimeRoot },
    systemClock
  );
  const merge = new GitHubMergeService(
    taskLookup,
    git,
    github,
    gates,
    approvals,
    githubArtifacts,
    ledger,
    systemClock
  );
  const postMerge = new GitHubPostMergeService(
    taskLookup,
    git,
    github,
    ci,
    githubArtifacts,
    ledger,
    systemClock
  );
  return {
    taskLookup,
    ledger,
    githubArtifacts,
    approvals,
    gates,
    external: new GitHubLifecycleRuntime(taskLookup, githubArtifacts, {
      remote,
      pullRequests,
      reviews,
      ci,
      gates,
      merge,
      postMerge
    })
  };
}
