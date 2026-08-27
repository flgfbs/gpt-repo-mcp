import type {
  AgentRunnerName,
  ExecutionSupervisorServiceIdentity
} from "../delegation/artifact-contracts.js";
import {
  DelegationQueueSupervisor,
  type BoundedWorkerLauncher,
  type DelegationQueueSupervisorOptions
} from "../delegation/queue-supervisor.js";
import { RepoReaderError } from "../runtime/errors.js";
import type { TaskRuntimeService } from "../task-runtime/index.js";
import type { RootRegistry } from "./root-registry.js";
import { TaskAdmissionService } from "./task-admission-service.js";

export type CreateDelegationQueueSupervisorInput = {
  repo_id: string;
  runner: AgentRunnerName;
  service_identity: ExecutionSupervisorServiceIdentity;
  launcher: BoundedWorkerLauncher;
  mode: DelegationQueueSupervisorOptions["mode"];
  max_runtime_ms?: number;
  stale_after_ms?: number;
  now?: () => Date;
};

/**
 * Construction seam for the existing repository lifecycle control plane.
 *
 * This object does not schedule scans, start processes, select a provider, or
 * read credentials. The owner runtime must explicitly construct a supervisor
 * and call scanOnce().
 */
export class DelegationExecutionRuntime {
  private readonly admission: TaskAdmissionService;

  constructor(
    private readonly registry: RootRegistry,
    tasks: TaskRuntimeService
  ) {
    this.admission = new TaskAdmissionService(registry, tasks);
  }

  createQueueSupervisor(input: CreateDelegationQueueSupervisorInput): DelegationQueueSupervisor {
    const repo = this.registry.get(input.repo_id);
    if (!repo.task) {
      throw new RepoReaderError(
        "LIFECYCLE_POLICY_DENIED",
        "Execution supervision requires an active server-bound task repository."
      );
    }
    if (repo.task.authority === "inspect") {
      throw new RepoReaderError(
        "LIFECYCLE_POLICY_DENIED",
        "Execution supervision requires implement or ship task authority."
      );
    }
    return new DelegationQueueSupervisor({
      root: repo.root,
      repo_id: input.repo_id,
      runner: input.runner,
      service_identity: input.service_identity,
      admission: this.admission,
      launcher: input.launcher,
      mode: input.mode,
      ...(input.max_runtime_ms === undefined ? {} : { max_runtime_ms: input.max_runtime_ms }),
      ...(input.stale_after_ms === undefined ? {} : { stale_after_ms: input.stale_after_ms }),
      ...(input.now === undefined ? {} : { now: input.now })
    });
  }
}
