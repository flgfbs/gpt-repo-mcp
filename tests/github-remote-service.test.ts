import { describe, expect, it } from "vitest";
import { GitHubBoundaryError } from "../src/github/types.js";
import { GitRemoteService } from "../src/services/git-remote-service.js";
import {
  FIXED_TASK,
  FixedClock,
  FixedTaskLookup,
  FakeGitBoundary,
  FakeGitHubAdapter,
  HEAD_SHA,
  MemoryArtifactSink,
  MemoryOperationLedger,
  TREE_SHA
} from "./fixtures/github-lifecycle-fixtures.js";

const input = (operationId: string) => ({
  operation_id: operationId,
  repo_id: FIXED_TASK.repoId,
  task_id: FIXED_TASK.taskId,
  expected_head_sha: HEAD_SHA,
  expected_tree_sha: TREE_SHA
});

describe("GitRemoteService", () => {
  it("records pre-contact before remote observation and returns stored state without duplicate contact", async () => {
    const fixture = createFixture();
    const result = await fixture.service.remoteStatus(input("remote-status-1"));
    expect(result).toMatchObject({
      disposition: "EXECUTED",
      aligned: true,
      relationship: "equal",
      remoteHeadSha: HEAD_SHA,
      remoteTreeSha: TREE_SHA,
      defaultBranch: { qualifiedName: "refs/heads/main" },
      provider: {
        transport: "gh_cli",
        host: "github.com",
        authentication: "inherited_not_inspected",
        repositoryId: "R_repo_node"
      },
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(phases(fixture.ledger, "remote-status-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);
    const contacts = fixture.github.calls.length;

    const duplicate = await fixture.service.remoteStatus(input("remote-status-1"));
    expect(duplicate).toMatchObject({ disposition: "STORED", operation: { phase: "EXTERNAL_SUCCEEDED" } });
    expect(fixture.github.calls).toHaveLength(contacts);
  });

  it("pushes a missing task ref once and proves the exact head and tree by readback", async () => {
    const fixture = createFixture();
    fixture.github.refs.delete(`refs/heads/${FIXED_TASK.branch}`);
    fixture.github.refTrees.delete(`refs/heads/${FIXED_TASK.branch}`);
    fixture.git.onPush = () => {
      fixture.github.refs.set(`refs/heads/${FIXED_TASK.branch}`, HEAD_SHA);
      fixture.github.refTrees.set(`refs/heads/${FIXED_TASK.branch}`, TREE_SHA);
    };

    const result = await fixture.service.writePush(input("push-operation-1"));
    expect(result).toMatchObject({
      disposition: "EXECUTED",
      pushed: true,
      remoteHeadSha: HEAD_SHA,
      operation: { phase: "EXTERNAL_SUCCEEDED" }
    });
    expect(fixture.git.pushCalls).toBe(1);
    expect(phases(fixture.ledger, "push-operation-1")).toEqual([
      "CREATED", "ADMITTED", "EXTERNAL_PRECONTACT", "EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED"
    ]);
  });

  it("records remote drift after a failed push as unknown and never pushes it again", async () => {
    const fixture = createFixture();
    fixture.github.refs.delete(`refs/heads/${FIXED_TASK.branch}`);
    fixture.github.refTrees.delete(`refs/heads/${FIXED_TASK.branch}`);
    fixture.git.onPush = () => {
      fixture.github.refs.set(`refs/heads/${FIXED_TASK.branch}`, "9999999999999999999999999999999999999999");
      fixture.github.refTrees.set(`refs/heads/${FIXED_TASK.branch}`, "8888888888888888888888888888888888888888");
    };
    fixture.git.pushError = new GitHubBoundaryError("PUSH_RESPONSE_LOST", "Simulated push response loss.", "UNKNOWN");

    await expect(fixture.service.writePush(input("push-operation-unknown"))).rejects.toMatchObject({
      code: "PUSH_REMOTE_DRIFT",
      operation: { phase: "UNKNOWN_AFTER_CONTACT" }
    });
    expect(fixture.git.pushCalls).toBe(1);

    const duplicate = await fixture.service.writePush(input("push-operation-unknown"));
    expect(duplicate).toMatchObject({ disposition: "STORED", operation: { phase: "UNKNOWN_AFTER_CONTACT" } });
    expect(fixture.git.pushCalls).toBe(1);
  });
});

function createFixture() {
  const tasks = new FixedTaskLookup();
  const git = new FakeGitBoundary();
  const github = new FakeGitHubAdapter();
  const artifacts = new MemoryArtifactSink();
  const ledger = new MemoryOperationLedger();
  const service = new GitRemoteService(tasks, git, github, artifacts, ledger, new FixedClock());
  return { tasks, git, github, artifacts, ledger, service };
}

function phases(ledger: MemoryOperationLedger, operationId: string): string[] {
  return ledger.history.filter((entry) => entry.operationId === operationId).map((entry) => entry.phase);
}
