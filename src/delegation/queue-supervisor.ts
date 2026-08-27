import {
  DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
  ExecutionSupervisorHealthAttestationSchema,
  ExecutionSupervisorServiceIdentitySchema,
  type AgentRunnerName,
  type ExecutionSupervisorHealthAttestation,
  type ExecutionSupervisorServiceIdentity
} from "./artifact-contracts.js";
import { DelegationDispatchStore } from "./dispatch-store.js";
import {
  WorkerLaunchOutcomeSchema,
  type AdmittedDispatch,
  type WorkerLaunchOutcome,
  type WorkerLaunchResult
} from "./execution-runtime-contracts.js";
import { DelegationRunStore, type DelegationRunRecord } from "./run-store.js";
import { DelegationSupervisorStore } from "./supervisor-store.js";
import type { DelegationRunTaskAdmission } from "../services/task-admission-service.js";
import { canonicalSha256, digestRecord } from "../task-runtime/canonical-json.js";

export interface DelegationRunAdmissionReader {
  readForDelegationRun(run: DelegationRunRecord): Promise<DelegationRunTaskAdmission>;
}

export interface BoundedWorkerLauncher {
  launch(input: {
    dispatch: AdmittedDispatch;
    run: DelegationRunRecord;
    max_runtime_ms: number;
  }): Promise<WorkerLaunchOutcome>;
}

export type DelegationQueueScanResult =
  | { outcome: "idle"; scanned_runs: number }
  | { outcome: "not_admitted"; scanned_runs: number; run_id: string; admission: "task_absent" | "conflicting_active_task"; reason: string }
  | { outcome: "already_settled"; scanned_runs: number; run_id: string; dispatch_id: string; result: WorkerLaunchResult }
  | { outcome: "launched"; scanned_runs: number; run_id: string; dispatch_id: string; result: WorkerLaunchResult }
  | { outcome: "blocked_unknown_effect"; scanned_runs: number; run_id: string; dispatch_id: string; reason: string };

export type DelegationQueueSupervisorOptions = {
  root: string;
  repo_id: string;
  runner: AgentRunnerName;
  service_identity: ExecutionSupervisorServiceIdentity;
  admission: DelegationRunAdmissionReader;
  launcher: BoundedWorkerLauncher;
  mode: "provider_free" | "external_worker";
  max_runtime_ms?: number;
  stale_after_ms?: number;
  now?: () => Date;
};

export class DelegationQueueSupervisor {
  private readonly now: () => Date;
  private readonly runs: DelegationRunStore;
  private readonly dispatches: DelegationDispatchStore;
  private readonly supervisor: DelegationSupervisorStore;
  private scanInFlight?: Promise<DelegationQueueScanResult>;

  constructor(private readonly options: DelegationQueueSupervisorOptions) {
    this.now = options.now ?? (() => new Date());
    ExecutionSupervisorServiceIdentitySchema.parse(options.service_identity);
    this.runs = new DelegationRunStore(options.root, { now: this.now });
    this.dispatches = new DelegationDispatchStore(options.root, this.now);
    this.supervisor = new DelegationSupervisorStore(options.root);
  }

  scanOnce(): Promise<DelegationQueueScanResult> {
    if (this.scanInFlight) return this.scanInFlight;
    const pending = this.scanOnceInternal().finally(() => {
      if (this.scanInFlight === pending) this.scanInFlight = undefined;
    });
    this.scanInFlight = pending;
    return pending;
  }

  private async scanOnceInternal(): Promise<DelegationQueueScanResult> {
    const scanAt = this.now().toISOString();
    await this.writeHealth({ status: "running", queue_consumer: "scanning", scanAt });
    const records = await this.runs.discoverRuns();
    let scanned = 0;
    let lastBlocked: Extract<DelegationQueueScanResult, { outcome: "not_admitted" }> | undefined;

    for (const run of records) {
      if (run.repo_id !== this.options.repo_id || run.runner.mode !== "queued" || run.runner.requested_runner !== this.options.runner) continue;
      const existingStatus = await this.runs.readStatus(run.run_id);
      if (existingStatus) continue;
      scanned += 1;
      const admission = await this.options.admission.readForDelegationRun(run);
      if (admission.admission !== "matching_active_task") {
        lastBlocked = {
          outcome: "not_admitted",
          scanned_runs: scanned,
          run_id: run.run_id,
          admission: admission.admission,
          reason: admission.reason
        };
        continue;
      }
      if (run.manifest.schema_version !== 3 || run.runner.requested_runner === undefined) {
        lastBlocked = {
          outcome: "not_admitted",
          scanned_runs: scanned,
          run_id: run.run_id,
          admission: "conflicting_active_task",
          reason: "UNSUPPORTED_RUN_BINDING"
        };
        continue;
      }
      const maxRuntimeMs = Math.min(
        run.runner.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS,
        this.options.max_runtime_ms ?? DEFAULT_AGENT_RUNNER_MAX_RUNTIME_MS
      );
      const { dispatch } = await this.dispatches.ensureAdmitted({
        repo_id: run.repo_id,
        run_id: run.run_id,
        runner: run.runner.requested_runner,
        task_binding: {
          task_id: admission.task.task_id,
          task_repo_id: admission.task.task_repo_id,
          base_repo_id: admission.task.base_repo_id,
          head_sha: admission.task.head_sha,
          tree_sha: admission.task.tree_sha,
          state_sha256: admission.task.state_sha256,
          binding_sha256: admission.task.binding_sha256
        },
        delegation_binding: {
          manifest_canonical_sha256: canonicalSha256(run.manifest),
          task_sha256: run.manifest.task_sha256,
          baseline_sha256: run.manifest.baseline_sha256,
          prompt_sha256: run.manifest.prompt_sha256
        },
        supervisor: this.options.service_identity,
        max_runtime_ms: maxRuntimeMs
      });
      const existingResult = await this.dispatches.readResult(run.run_id);
      const existingIntent = await this.dispatches.readIntent(run.run_id);
      if (existingResult) {
        if (!existingIntent || existingResult.dispatch_id !== dispatch.dispatch_id) {
          return this.blockUnknown(scanAt, scanned, run, dispatch, "RESULT_WITHOUT_MATCHING_INTENT");
        }
        if (existingResult.effect_state === "unknown") {
          return this.blockUnknown(scanAt, scanned, run, dispatch, "PERSISTED_UNKNOWN_EFFECT", false);
        }
        await this.writeHealth({
          status: "ready",
          queue_consumer: "idle",
          scanAt,
          lastClaimedRunId: run.run_id,
          providerContact: publicProviderContact(existingResult.provider_contact)
        });
        return {
          outcome: "already_settled",
          scanned_runs: scanned,
          run_id: run.run_id,
          dispatch_id: dispatch.dispatch_id,
          result: existingResult
        };
      }
      if (existingIntent) {
        return this.blockUnknown(scanAt, scanned, run, dispatch, "LAUNCH_INTENT_WITHOUT_RESULT");
      }
      const { intent, created } = await this.dispatches.ensureLaunchIntent(dispatch, this.options.service_identity);
      if (!created) {
        return this.blockUnknown(scanAt, scanned, run, dispatch, "CONCURRENT_LAUNCH_INTENT_WITHOUT_RESULT");
      }
      await this.writeHealth({
        status: "running",
        queue_consumer: "launching",
        scanAt,
        activeDispatchId: dispatch.dispatch_id,
        activeRunId: run.run_id,
        lastClaimedRunId: run.run_id
      });
      let outcome: WorkerLaunchOutcome;
      try {
        outcome = WorkerLaunchOutcomeSchema.parse(await this.options.launcher.launch({
          dispatch,
          run,
          max_runtime_ms: maxRuntimeMs
        }));
        if (this.options.mode === "provider_free" && outcome.provider_contact !== "none") {
          throw new Error("Provider-free supervisor observed provider contact.");
        }
      } catch {
        outcome = {
          effect_state: "unknown",
          provider_contact: "unknown",
          terminal_state: "unknown",
          outcome_code: "LAUNCH_BOUNDARY_UNKNOWN"
        };
      }
      let written: WorkerLaunchResult;
      try {
        written = (await this.dispatches.writeLaunchResult({
          dispatch,
          outcome,
          started_at: intent.requested_at
        })).result;
      } catch {
        return this.blockUnknown(scanAt, scanned, run, dispatch, "RESULT_WRITE_UNKNOWN");
      }
      if (written.effect_state === "unknown") {
        await this.writeHealth({
          status: "degraded",
          queue_consumer: "blocked_unknown_effect",
          scanAt,
          activeDispatchId: dispatch.dispatch_id,
          lastClaimedRunId: run.run_id,
          incrementUnknown: true,
          providerContact: publicProviderContact(written.provider_contact),
          warnings: ["UNKNOWN_EFFECT_NO_REPLAY"]
        });
        return {
          outcome: "blocked_unknown_effect",
          scanned_runs: scanned,
          run_id: run.run_id,
          dispatch_id: dispatch.dispatch_id,
          reason: written.outcome_code
        };
      }
      await this.writeHealth({
        status: "ready",
        queue_consumer: "idle",
        scanAt,
        lastClaimedRunId: run.run_id,
        providerContact: publicProviderContact(written.provider_contact)
      });
      return {
        outcome: "launched",
        scanned_runs: scanned,
        run_id: run.run_id,
        dispatch_id: dispatch.dispatch_id,
        result: written
      };
    }

    await this.writeHealth({
      status: "ready",
      queue_consumer: "idle",
      scanAt,
      warnings: lastBlocked ? ["QUEUED_RUN_NOT_ADMITTED"] : []
    });
    return lastBlocked ?? { outcome: "idle", scanned_runs: scanned };
  }

  private async blockUnknown(
    scanAt: string,
    scanned: number,
    run: DelegationRunRecord,
    dispatch: AdmittedDispatch,
    reason: string,
    incrementUnknown = true
  ): Promise<DelegationQueueScanResult> {
    await this.writeHealth({
      status: "degraded",
      queue_consumer: "blocked_unknown_effect",
      scanAt,
      activeDispatchId: dispatch.dispatch_id,
      lastClaimedRunId: run.run_id,
      incrementUnknown,
      providerContact: "possible",
      warnings: ["UNKNOWN_EFFECT_NO_REPLAY"]
    });
    return {
      outcome: "blocked_unknown_effect",
      scanned_runs: scanned,
      run_id: run.run_id,
      dispatch_id: dispatch.dispatch_id,
      reason
    };
  }

  private async writeHealth(input: {
    status: "ready" | "running" | "degraded" | "stopped";
    queue_consumer: "idle" | "scanning" | "launching" | "blocked_unknown_effect";
    scanAt: string;
    activeDispatchId?: string;
    activeRunId?: string;
    lastClaimedRunId?: string;
    incrementUnknown?: boolean;
    providerContact?: "none" | "possible" | "confirmed";
    warnings?: string[];
  }): Promise<void> {
    const current = await this.supervisor.read();
    const priorUnknown = current?.health_attestation?.unknown_effect_count ?? 0;
    const unsigned = {
      schema_version: 1 as const,
      service_identity: this.options.service_identity,
      status: input.status,
      queue_consumer: input.queue_consumer,
      active_dispatch_id: input.activeDispatchId ?? null,
      last_scan_at: input.scanAt,
      unknown_effect_count: input.incrementUnknown ? priorUnknown + 1 : priorUnknown,
      provider_contact: input.providerContact ?? "none",
      live_effects_enabled: this.options.mode === "external_worker",
      attested_at: this.now().toISOString(),
      attestation_sha256: "0".repeat(64)
    };
    const health: ExecutionSupervisorHealthAttestation = ExecutionSupervisorHealthAttestationSchema.parse({
      ...unsigned,
      attestation_sha256: digestRecord(unsigned, "attestation_sha256")
    });
    await this.supervisor.write({
      repo_id: this.options.repo_id,
      runner: this.options.runner,
      status: input.status,
      heartbeat_at: health.attested_at,
      last_scan_at: input.scanAt,
      last_claimed_run_id: input.lastClaimedRunId ?? current?.last_claimed_run_id ?? null,
      active_run_id: input.activeRunId ?? null,
      stale_after_ms: this.options.stale_after_ms ?? 30_000,
      service_identity: this.options.service_identity,
      health_attestation: health,
      warnings: input.warnings ?? []
    });
  }
}

function publicProviderContact(value: WorkerLaunchResult["provider_contact"]): "none" | "possible" | "confirmed" {
  if (value === "confirmed") return "confirmed";
  if (value === "unknown") return "possible";
  return "none";
}
