import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoRunFableReviewInput } from "../../src/contracts/fable-review.contract.js";
import { createLifecycleRuntimeBundle, type LifecycleRuntimeBundle } from "../../src/services/lifecycle-factory.js";
import {
  canonicalFableLauncherRequestBytes,
  type FableLauncherInvocation,
  type FableLauncherPort,
  type FableLauncherPreflight,
  type PreparedFableInvocation
} from "../../src/services/fable-launcher-port.js";
import { ManagedFableReviewService } from "../../src/services/managed-fable-review-service.js";
import { RootRegistry } from "../../src/services/root-registry.js";
import { sha256Hex } from "../../src/task-runtime/canonical-json.js";

const execFileAsync = promisify(execFile);

const PREFLIGHT: FableLauncherPreflight = {
  launcher_sha256: "a".repeat(64),
  router_sha256: "b".repeat(64),
  request_schema: "claude-review-router-typed-launch.v2",
  provider_contact_limit: 1,
  model_class: "FABLE",
  reasoning: "MAX"
};

export type TaskFixture = {
  parent: string;
  bundle: LifecycleRuntimeBundle;
  registry: RootRegistry;
  taskRoot: string;
  taskRepoId: string;
  taskId: string;
  baseCommit: string;
  baseTree: string;
  service(launcher: FableLauncherPort): ManagedFableReviewService;
};

export type FakeMode = "PASS" | "REVISE" | "PARTIAL" | "THROW";

export async function managedTaskFixture(): Promise<TaskFixture> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "managed-fable-review-")));
  const ownerRoot = join(parent, "owner");
  const runtimeRoot = join(parent, "runtime");
  const worktreeRoot = join(parent, "worktrees");
  await mkdir(ownerRoot);
  await git(ownerRoot, "init", "-b", "main");
  await git(ownerRoot, "config", "user.name", "Fable Review Test");
  await git(ownerRoot, "config", "user.email", "fable-review@example.com");
  await writeFile(join(ownerRoot, "README.md"), "# Managed Fable fixture\n");
  await git(ownerRoot, "add", "--", "README.md");
  await git(ownerRoot, "commit", "-m", "Initial fixture");
  const baseCommit = await git(ownerRoot, "rev-parse", "HEAD");
  const baseTree = await git(ownerRoot, "rev-parse", "HEAD^{tree}");
  const registry = await RootRegistry.fromConfig({
    repos: [{
      repo_id: "fable-owner",
      display_name: "Managed Fable owner fixture",
      root: ownerRoot,
      writes: { enabled: true, allowed_globs: ["**"] },
      operations: {
        enabled: true,
        git_stage_enabled: true,
        git_commit_enabled: true,
        validation_enabled: true,
        cleanup_enabled: true
      },
      lifecycle: {
        kind: "local",
        authority: "ship",
        allowed_base_branches: ["main"],
        worktree_root: worktreeRoot,
        require_clean_base: true,
        max_concurrent_tasks: 4
      }
    }],
    limits: {},
    runtime_root: runtimeRoot
  });
  const bundle = await createLifecycleRuntimeBundle(registry);
  const taskId = "managed-fable-task";
  const opened = await bundle.lifecycle.taskOpen({
    operation_id: "operation-open-managed-fable-task",
    repo_id: "fable-owner",
    task_id: taskId,
    base_branch: "main",
    base_commit_sha: baseCommit,
    base_tree_sha: baseTree,
    authority: "ship",
    goal: "Exercise the exact-head managed Fable review surface provider-free.",
    branch_slug: "managed-fable-review"
  });
  return {
    parent,
    bundle,
    registry,
    taskRoot: opened.task.worktree_path,
    taskRepoId: opened.task.repo_id,
    taskId,
    baseCommit,
    baseTree,
    service: (launcher) => new ManagedFableReviewService(
      registry,
      bundle.tasks,
      bundle.artifacts,
      launcher,
      { now: () => new Date("2026-09-04T00:00:00.000Z") }
    )
  };
}

export async function commitTaskChange(root: string, path: string, content: string) {
  await writeFile(join(root, path), content);
  await git(root, "add", "--", path);
  await git(root, "commit", "-m", `Change ${path}`);
  return {
    head: await git(root, "rev-parse", "HEAD"),
    tree: await git(root, "rev-parse", "HEAD^{tree}")
  };
}

export function initialInput(
  fixture: TaskFixture,
  committed: { head: string; tree: string },
  operationId: string,
  overrides: Partial<RepoRunFableReviewInput> = {}
): RepoRunFableReviewInput {
  return {
    operation_id: operationId,
    repo_id: fixture.taskRepoId,
    task_id: fixture.taskId,
    expected_base_commit_sha: fixture.baseCommit,
    expected_base_tree_sha: fixture.baseTree,
    expected_head_sha: committed.head,
    expected_tree_sha: committed.tree,
    review_kind: "initial",
    scope: { kind: "all_changes" },
    ...overrides
  } as RepoRunFableReviewInput;
}

export class FakeFableLauncher implements FableLauncherPort {
  invocationCount = 0;
  readonly requests: Array<Record<string, unknown>> = [];

  constructor(
    private readonly modes: FakeMode[],
    private readonly preflightFailure?: string
  ) {}

  async preflight(): Promise<FableLauncherPreflight> {
    if (this.preflightFailure) throw new Error(this.preflightFailure);
    return PREFLIGHT;
  }

  async prepare(input: {
    bundle_id: string;
    request: Record<string, unknown>;
    packet: Buffer;
  }): Promise<PreparedFableInvocation> {
    return {
      bundle_id: input.bundle_id,
      request_sha256: sha256Hex(canonicalFableLauncherRequestBytes(input.request)),
      packet_sha256: sha256Hex(input.packet),
      opaque_state: { request: input.request, packet: input.packet.toString("utf8") }
    };
  }

  async invoke(prepared: PreparedFableInvocation): Promise<FableLauncherInvocation> {
    this.invocationCount += 1;
    const state = prepared.opaque_state as { request: Record<string, unknown>; packet: string };
    this.requests.push(state.request);
    const mode = this.modes.shift();
    if (mode === "THROW") throw new Error("ambiguous local transport failure");
    if (mode === "PARTIAL") {
      return {
        exit_code: 1,
        timed_out: false,
        output_complete: true,
        payload: {
          result: "STOP_PROVIDER_RESPONSE_INCOMPLETE",
          provider_contact: "YES",
          effect_disposition: "PARTIAL_EXTERNAL_EFFECT",
          retry_authorized: "NO"
        }
      };
    }
    if (mode !== "PASS" && mode !== "REVISE") throw new Error("No fake result was configured.");
    return successfulInvocation(state.request, state.packet, prepared.packet_sha256, this.invocationCount, mode);
  }
}

function successfulInvocation(
  request: Record<string, unknown>,
  packetText: string,
  packetSha256: string,
  invocation: number,
  status: "PASS" | "REVISE"
): FableLauncherInvocation {
  const requestTarget = request.target as Record<string, string>;
  const requestOperation = request.operation as Record<string, unknown>;
  const header = JSON.parse(packetText.split("\n", 3)[1]!) as {
    target: { scope_sha256: string };
  };
  const attemptId = invocation.toString(16).padStart(32, "0");
  const responseSha256 = invocation.toString(16).repeat(64).slice(0, 64);
  const receiptSha256 = (invocation + 8).toString(16).repeat(64).slice(0, 64);
  const findings = status === "PASS" ? [] : [{
    finding_id: "FABLE-1",
    severity: "P1",
    summary: "Correction required.",
    evidence: "The exact implementation needs one focused correction.",
    impact: "The contract would otherwise be incomplete.",
    uncertainty: "Low.",
    proposed_test: "Apply the correction and run focused rereview."
  }];
  return {
    exit_code: 0,
    timed_out: false,
    output_complete: true,
    payload: {
      result: status,
      invocation_id: attemptId,
      sanitized_diagnostic_path: `runtime/claude_lain2/diagnostics/invocations/${attemptId}/receipt.json`,
      route: "sensitive-route-marker",
      response: "sensitive-response-marker",
      resolved_models: ["sensitive-model-marker"],
      model_class: "FABLE",
      reasoning: "MAX",
      terminal_title_suppression: "ACTIVE",
      automatic_fallback: "DISABLED",
      refusal_fallback: "DISABLED",
      explicit_concurrency_limit: 1,
      review_result: {
        schema: "claude-review-router-findings.v1",
        review_status: status,
        summary: status === "PASS" ? "No material findings." : "One material correction is required.",
        findings
      },
      response_binding: { sha256: responseSha256, utf8_bytes: 120 },
      review_record: {
        attempt_id: attemptId,
        provider_contact_state: "YES",
        valid_semantic_review_state: "YES",
        effect_disposition: "VALID_REVIEW_RESULT",
        requested_model_class_attestation: "FABLE",
        observed_model_class_attestation: "FABLE",
        requested_reasoning_attestation: "MAX",
        observed_reasoning_attestation: "MAX",
        focused_rereview_state: requestOperation.kind === "FOCUSED_REREVIEW" ? "FOCUSED" : "INITIAL",
        exact_target_bindings: {
          commit: requestTarget.commit,
          tree: requestTarget.tree,
          digest: `sha256:${packetSha256}`,
          target_scope_sha256: header.target.scope_sha256
        }
      },
      attestation: {
        capability_class: "FABLE",
        reasoning: "MAX",
        terminal_title_suppression: "ACTIVE",
        tools: "DISABLED",
        mcp: "DISABLED",
        session_persistence: false,
        automatic_fallback: "DISABLED",
        refusal_fallback: "DISABLED",
        provider_retry: "DISABLED",
        provider_retry_limit: 0
      },
      response_retention: {
        availability: "AVAILABLE",
        location_marker: "sensitive-location-marker"
      }
    },
    receipt_readback: {
      ok: true,
      attempt_id: attemptId,
      receipt_sha256: receiptSha256,
      response_sha256: responseSha256,
      response_utf8_bytes: 120
    }
  };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    maxBuffer: 2 * 1024 * 1024
  });
  return result.stdout.trim();
}
