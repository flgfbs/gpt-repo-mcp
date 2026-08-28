#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readConfigDocument, resolveConfigPath } from "./config/store.js";
import { validateConfigDocument } from "./config/validation.js";
import {
  CodexAppServerInitialRunner,
  type CodexAppServerReconciliationResult
} from "./services/codex-app-server-initial-runner.js";
import { createLifecycleRuntimeBundle, type LifecycleRuntimeBundle } from "./services/lifecycle-factory.js";
import { RootRegistry } from "./services/root-registry.js";
import type { DelegationQueueScanResult } from "./delegation/queue-supervisor.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type OwnerAgentRunnerCycleResult = {
  task_repositories: number;
  reconciliations: Array<{ repo_id: string; result: CodexAppServerReconciliationResult }>;
  scans: Array<{ repo_id: string; result: DelegationQueueScanResult }>;
  failures: Array<{ repo_id: string; code: string }>;
};

export type OwnerAgentRunnerOptions = {
  initial_runner?: CodexAppServerInitialRunner;
  instance_id?: string;
  on_cycle?: (result: OwnerAgentRunnerCycleResult) => void;
};

export class OwnerAgentRunnerRuntime {
  private readonly initialRunner: CodexAppServerInitialRunner;
  private readonly instanceId: string;

  constructor(
    private readonly registry: RootRegistry,
    private readonly lifecycle: LifecycleRuntimeBundle,
    options: OwnerAgentRunnerOptions = {}
  ) {
    this.initialRunner = options.initial_runner
      ?? new CodexAppServerInitialRunner(registry, lifecycle.tasks);
    this.instanceId = options.instance_id ?? "owner-local";
    this.onCycle = options.on_cycle;
  }

  private readonly onCycle?: (result: OwnerAgentRunnerCycleResult) => void;

  async cycle(): Promise<OwnerAgentRunnerCycleResult> {
    await this.lifecycle.tasks.rehydrateOpenTaskRepositories({ limit: 10_000 });
    const taskRepos = this.registry.listTaskRepos().filter(({ authority }) => authority !== "inspect");
    const result: OwnerAgentRunnerCycleResult = {
      task_repositories: taskRepos.length,
      reconciliations: [],
      scans: [],
      failures: []
    };
    for (const task of taskRepos) {
      try {
        const reconciliation = await this.initialRunner.reconcileRepository(task.task_repo_id);
        result.reconciliations.push({ repo_id: task.task_repo_id, result: reconciliation });
        const supervisor = this.lifecycle.executionRuntime.createQueueSupervisor({
          repo_id: task.task_repo_id,
          runner: "codex_app_server",
          service_identity: {
            schema_version: 1,
            service_id: "owner-local-codex-app-server-runner",
            instance_id: this.instanceId,
            implementation: "chat-pro-repository-mcp",
            protocol: "semantic-worker-dispatch-v1"
          },
          launcher: this.initialRunner,
          mode: "external_worker"
        });
        result.scans.push({ repo_id: task.task_repo_id, result: await supervisor.scanOnce() });
      } catch (error) {
        result.failures.push({ repo_id: task.task_repo_id, code: stableErrorCode(error) });
      }
    }
    this.onCycle?.(result);
    return result;
  }

  async close(): Promise<void> {
    await this.initialRunner.close();
  }
}

export async function createOwnerAgentRunnerRuntime(
  configPath: string,
  options: OwnerAgentRunnerOptions = {}
): Promise<OwnerAgentRunnerRuntime> {
  const validation = await validateConfigDocument(await readConfigDocument(configPath));
  if (validation.issues.length > 0) {
    throw new Error(`Owner agent runner refused invalid configuration: ${validation.issues.map(({ code }) => code).join(",")}`);
  }
  const registry = await RootRegistry.fromFile(configPath);
  const lifecycle = await createLifecycleRuntimeBundle(registry);
  return new OwnerAgentRunnerRuntime(registry, lifecycle, options);
}

export async function runOwnerAgentRunner(input: {
  config_path: string;
  signal?: AbortSignal;
  poll_interval_ms?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  on_cycle?: (result: OwnerAgentRunnerCycleResult) => void;
}): Promise<void> {
  const pollIntervalMs = boundedPollInterval(input.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS);
  const runtime = await createOwnerAgentRunnerRuntime(input.config_path, { on_cycle: input.on_cycle });
  const sleep = input.sleep ?? abortableSleep;
  try {
    while (!input.signal?.aborted) {
      await runtime.cycle();
      if (input.signal?.aborted) break;
      await sleep(pollIntervalMs, input.signal);
    }
  } finally {
    await runtime.close();
  }
}

function parseConfigPath(argv: string[]): string {
  let cliConfigPath: string | undefined;
  if (argv.length > 0) {
    if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) {
      throw new Error("Usage: owner-agent-runner --config <path>");
    }
    cliConfigPath = argv[1];
  }
  return resolveConfigPath({ cliConfigPath, env: process.env, cwd: process.cwd() });
}

function stableErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    const code = error.code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 128);
    if (/^[A-Z][A-Z0-9_]*$/.test(code)) return code;
  }
  return "OWNER_RUNNER_CYCLE_FAILED";
}

function boundedPollInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new Error("Owner agent runner poll interval must be between 100 and 60000 milliseconds.");
  }
  return value;
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const currentModule = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === currentModule) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    await runOwnerAgentRunner({
      config_path: parseConfigPath(process.argv.slice(2)),
      signal: controller.signal,
      on_cycle: (result) => {
        const active = result.scans.filter(({ result: scan }) => scan.outcome !== "idle");
        const rebound = result.reconciliations.reduce((sum, entry) => sum + entry.result.rebound + entry.result.settled, 0);
        if (active.length > 0 || rebound > 0 || result.failures.length > 0) {
          process.stdout.write(`${JSON.stringify({ event: "owner_agent_runner_cycle", ...result })}\n`);
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Owner agent runner failed: ${message}\n`);
    process.exitCode = 1;
  }
}
