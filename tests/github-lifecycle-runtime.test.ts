import { describe, expect, it, vi } from "vitest";
import type { GitHubOperationRecord, JsonValue, TaskLookup } from "../src/github/types.js";
import {
  GitHubLifecycleRuntime,
  type GitHubLifecycleServices
} from "../src/services/github-lifecycle-runtime.js";
import type { TaskArtifactMetadata } from "../src/task-runtime/index.js";
import { FIXED_TASK, HEAD_SHA, TREE_SHA } from "./fixtures/github-lifecycle-fixtures.js";

const ARTIFACT_ID = "artifact_ABCDEFGHIJKLMNOP";
const ARTIFACT_SHA = "b".repeat(64);
const CI_DIGEST = "a".repeat(64);

describe("GitHub lifecycle public runtime", () => {
  it("returns the stored exact result without reconstructing a new provider result", async () => {
    const evidence = {
      semantic: "repo_remote_status",
      repoId: FIXED_TASK.repoId,
      taskId: FIXED_TASK.taskId,
      taskBranchName: FIXED_TASK.branch,
      defaultBranchName: FIXED_TASK.baseBranch,
      localUpstream: "origin/task/change",
      remoteName: "origin",
      normalizedRemoteIdentity: "github.com/example/project",
      configuredRepositoryIdentity: "example/project",
      localHeadSha: HEAD_SHA,
      localTreeSha: TREE_SHA,
      remoteHeadSha: HEAD_SHA,
      remoteTreeSha: TREE_SHA,
      defaultBranchHeadSha: "3".repeat(40),
      defaultBranchTreeSha: "4".repeat(40),
      relationship: "equal"
    } satisfies JsonValue;
    const operation = record("repo_remote_status", "EXTERNAL_SUCCEEDED", {
      artifactId: ARTIFACT_ID,
      artifactDigest: ARTIFACT_SHA
    });
    const remoteStatus = vi.fn()
      .mockResolvedValueOnce({ disposition: "EXECUTED" as const, operation })
      .mockResolvedValueOnce({ disposition: "STORED" as const, operation });
    const runtime = runtimeWith({ remoteStatus }, evidence);
    const input = exactInput("remote-operation-1");

    const first = await runtime.remoteStatus(input);
    const stored = await runtime.remoteStatus(input);

    expect(stored).toEqual(first);
    expect(remoteStatus).toHaveBeenCalledTimes(2);
    expect(stored.task_branch).toEqual({
      name: FIXED_TASK.branch,
      exists: true,
      head_sha: HEAD_SHA,
      tree_sha: TREE_SHA
    });
    expect(stored.normalized_remote_identity).toBe("github.com/example/project");
  });

  it("surfaces and replays aggregated exact CI evidence while preserving its digest", async () => {
    const evidence = {
      semantic: "repo_ci_status",
      repoId: FIXED_TASK.repoId,
      taskId: FIXED_TASK.taskId,
      headSha: HEAD_SHA,
      overall: "failure",
      requiredChecks: [{
        key: "check:github-actions:test",
        required: { kind: "check_run", name: "test", appSlug: "github-actions" },
        status: "failure",
        sourceIds: [10, 11],
        conclusion: "timed_out"
      }],
      workflowRuns: [{
        id: 9001,
        headSha: HEAD_SHA,
        attempt: 1,
        status: "completed",
        conclusion: "timed_out",
        workflowName: "CI",
        event: "push",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:30.000Z",
        url: "https://github.com/example/project/actions/runs/9001",
        jobs: [{
          id: 9101,
          name: "test",
          status: "completed",
          conclusion: "timed_out",
          startedAt: "2026-08-23T00:00:01.000Z",
          completedAt: "2026-08-23T00:00:29.000Z",
          url: "https://github.com/example/project/actions/runs/9001/job/9101",
          failureSummary: ["step 1: test (timed_out)"]
        }]
      }],
      observedAt: "2026-08-23T00:00:31.000Z"
    } satisfies JsonValue;
    const operation = record("repo_ci_status", "EXTERNAL_SUCCEEDED", {
      ciStatusId: `ci_status_${CI_DIGEST}`,
      artifactId: ARTIFACT_ID,
      artifactDigest: CI_DIGEST
    });
    const ciStatus = vi.fn()
      .mockResolvedValueOnce({ disposition: "EXECUTED" as const, operation })
      .mockResolvedValueOnce({ disposition: "STORED" as const, operation });
    const runtime = runtimeWith({ ciStatus }, evidence);

    const result = await runtime.ciStatus(exactInput("ci-operation-1"));
    const stored = await runtime.ciStatus(exactInput("ci-operation-1"));

    expect(stored).toEqual(result);
    expect(ciStatus).toHaveBeenCalledTimes(2);
    expect(result.ci_status_id).toBe(`ci_status_${CI_DIGEST}`);
    expect(result.artifact.sha256).toBe(ARTIFACT_SHA);
    expect(result.runs[0]).toMatchObject({
      run_id: "9001",
      event: "push",
      jobs: [{ job_id: "9101", failure_summary: ["step 1: test (timed_out)"] }]
    });
    expect(result.required_checks).toEqual([{
      key: "check:github-actions:test",
      kind: "check_run",
      status: "failure",
      conclusion: "timed_out"
    }]);
    expect(result.warnings).toEqual(["CI_REQUIRED_CHECK_MULTIPLE_SOURCES_AGGREGATED"]);
  });

  it("preserves the singular public source id without an aggregation warning", async () => {
    const evidence = {
      semantic: "repo_ci_status",
      repoId: FIXED_TASK.repoId,
      taskId: FIXED_TASK.taskId,
      headSha: HEAD_SHA,
      overall: "success",
      requiredChecks: [{
        key: "check:github-actions:test",
        required: { kind: "check_run", name: "test", appSlug: "github-actions" },
        status: "success",
        sourceId: 10,
        sourceIds: [10],
        conclusion: "success"
      }],
      workflowRuns: [],
      observedAt: "2026-08-23T00:00:31.000Z"
    } satisfies JsonValue;
    const operation = record("repo_ci_status", "EXTERNAL_SUCCEEDED", {
      ciStatusId: `ci_status_${CI_DIGEST}`,
      artifactId: ARTIFACT_ID,
      artifactDigest: CI_DIGEST
    });
    const runtime = runtimeWith({
      ciStatus: vi.fn(async () => ({ disposition: "EXECUTED" as const, operation }))
    }, evidence);

    const result = await runtime.ciStatus(exactInput("ci-operation-single-source"));

    expect(result.required_checks).toEqual([{
      key: "check:github-actions:test",
      kind: "check_run",
      status: "success",
      source_id: "10",
      conclusion: "success"
    }]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects malformed aggregated source ids before public projection", async () => {
    const evidence = {
      semantic: "repo_ci_status",
      repoId: FIXED_TASK.repoId,
      taskId: FIXED_TASK.taskId,
      headSha: HEAD_SHA,
      overall: "success",
      requiredChecks: [{
        key: "check:github-actions:test",
        required: { kind: "check_run", name: "test", appSlug: "github-actions" },
        status: "success",
        sourceIds: [11, 10],
        conclusion: "success"
      }],
      workflowRuns: [],
      observedAt: "2026-08-23T00:00:31.000Z"
    } satisfies JsonValue;
    const operation = record("repo_ci_status", "EXTERNAL_SUCCEEDED", {
      ciStatusId: `ci_status_${CI_DIGEST}`,
      artifactId: ARTIFACT_ID,
      artifactDigest: CI_DIGEST
    });
    const runtime = runtimeWith({
      ciStatus: vi.fn(async () => ({ disposition: "EXECUTED" as const, operation }))
    }, evidence);

    await expect(runtime.ciStatus(exactInput("ci-operation-malformed-sources"))).rejects.toMatchObject({
      code: "TASK_OPERATION_BLOCKED",
      diagnostics: { failure_code: "EVIDENCE_SCHEMA_INVALID" }
    });
  });

  it("reports an unknown contacted effect and never attempts evidence replay", async () => {
    const operation = record("repo_write_push", "UNKNOWN_AFTER_CONTACT", undefined, "PUSH_REMOTE_DRIFT");
    const writePush = vi.fn(async () => ({ disposition: "STORED" as const, operation }));
    const reader = vi.fn();
    const runtime = new GitHubLifecycleRuntime(taskLookup(), { readArtifact: reader }, services({ writePush }));

    await expect(runtime.writePush(exactInput("push-operation-unknown"))).rejects.toMatchObject({
      code: "EXTERNAL_EFFECT_UNKNOWN",
      diagnostics: {
        operation_id: "test-operation",
        phase: "UNKNOWN_AFTER_CONTACT",
        failure_code: "PUSH_REMOTE_DRIFT"
      }
    });
    expect(reader).not.toHaveBeenCalled();
  });
});

function runtimeWith(overrides: Partial<GitHubLifecycleServices["remote"] & GitHubLifecycleServices["ci"]>, evidence: JsonValue) {
  return new GitHubLifecycleRuntime(taskLookup(), {
    readArtifact: async () => ({ metadata: artifactMetadata(), value: structuredClone(evidence) })
  }, services(overrides));
}

function services(overrides: Record<string, unknown>): GitHubLifecycleServices {
  const unused = async (): Promise<never> => { throw new Error("unexpected service call"); };
  return {
    remote: {
      remoteStatus: overrides.remoteStatus as GitHubLifecycleServices["remote"]["remoteStatus"] ?? unused,
      writePush: overrides.writePush as GitHubLifecycleServices["remote"]["writePush"] ?? unused
    },
    pullRequests: { prCreateOrUpdate: unused, prStatus: unused },
    reviews: { prReviewThreads: unused, writePrReply: unused, writePrResolveThread: unused },
    ci: {
      ciStatus: overrides.ciStatus as GitHubLifecycleServices["ci"]["ciStatus"] ?? unused,
      writeCiRetryFailed: unused
    },
    gates: { mergeGatePrepare: unused },
    merge: { writeMerge: unused },
    postMerge: { postMergeReadback: unused }
  };
}

function taskLookup(): TaskLookup {
  return { getServerOwnedTask: async () => structuredClone(FIXED_TASK) };
}

function exactInput(operationId: string) {
  return {
    operation_id: operationId,
    repo_id: FIXED_TASK.repoId,
    task_id: FIXED_TASK.taskId,
    expected_head_sha: HEAD_SHA,
    expected_tree_sha: TREE_SHA
  };
}

function record(
  semantic: GitHubOperationRecord["semantic"],
  phase: GitHubOperationRecord["phase"],
  result?: JsonValue,
  failureCode?: string
): GitHubOperationRecord {
  return {
    operationId: "test-operation",
    semantic,
    repoId: FIXED_TASK.repoId,
    taskId: FIXED_TASK.taskId,
    subjectDigest: "1".repeat(64),
    bindingDigest: "2".repeat(64),
    phase,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:31.000Z",
    ...(result === undefined ? {} : { result }),
    ...(failureCode ? { failureCode } : {})
  };
}

function artifactMetadata(): TaskArtifactMetadata {
  return {
    schema_version: 1,
    task_id: FIXED_TASK.taskId,
    artifact_id: ARTIFACT_ID,
    kind: "ci_evidence",
    media_type: "application/json",
    logical_path: "github/test.json",
    content_sha256: ARTIFACT_SHA,
    byte_length: 100,
    created_at: "2026-08-23T00:00:31.000Z",
    metadata_sha256: "c".repeat(64)
  };
}
