import { describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/register.js";
import type { RuntimeContext } from "../src/runtime/context.js";
import { GitRemoteService } from "../src/services/git-remote-service.js";
import { GitHubPushReconciliationService } from "../src/services/github-push-reconciliation-service.js";
import { GitHubMergeGateService } from "../src/services/github-merge-gate-service.js";
import { GitHubReviewService } from "../src/services/github-review-service.js";
import { GitHubCiService } from "../src/services/github-ci-service.js";
import { RepoWritePushReconciliationInputSchema } from "../src/contracts/push-reconciliation.contract.js";
import { sha256Json, type GitHubOperationRecord, type JsonValue } from "../src/github/types.js";
import {
  BASE_SHA, BASE_TREE_SHA, FIXED_TASK, HEAD_SHA, TREE_SHA, FakeGitBoundary, FakeGitHubAdapter,
  FixedClock, FixedMergeEvidenceProvider, FixedTaskLookup, MemoryArtifactSink, MemoryOperationLedger, makeReviewThread
} from "./fixtures/github-lifecycle-fixtures.js";

async function setup(later = false) {
  const tasks = new FixedTaskLookup();
  const git = new FakeGitBoundary();
  const github = new FakeGitHubAdapter();
  const ledger = new MemoryOperationLedger();
  const artifacts = new MemoryArtifactSink();
  const clock = new FixedClock();
  const remote = new GitRemoteService(tasks, git, github, artifacts, ledger, clock);
  const exact = (operation_id: string) => ({
    operation_id, repo_id: FIXED_TASK.repoId, task_id: FIXED_TASK.taskId,
    expected_head_sha: git.snapshot.headSha, expected_tree_sha: git.snapshot.treeSha
  });
  github.refs.set("refs/heads/" + FIXED_TASK.branch, BASE_SHA);
  github.refTrees.set("refs/heads/" + FIXED_TASK.branch, BASE_TREE_SHA);
  await expect(remote.writePush(exact("original-unknown-push"))).rejects.toMatchObject({ code: "PUSH_READBACK_MISMATCH" });
  const original = (await ledger.readExact("original-unknown-push"))!;
  const originalBytes = JSON.stringify(original);
  clock.advance(1000);
  if (later) {
    git.snapshot.headSha = "a".repeat(40);
    git.snapshot.treeSha = "b".repeat(40);
  }
  github.refs.set("refs/heads/" + FIXED_TASK.branch, git.snapshot.headSha);
  github.refTrees.set("refs/heads/" + FIXED_TASK.branch, git.snapshot.treeSha);
  await remote.remoteStatus(exact("later-remote-status"));
  const observation = (await ledger.readExact("later-remote-status"))!;
  const observationBytes = JSON.stringify(observation);
  clock.advance(1000);
  const service = new GitHubPushReconciliationService(tasks, git, github, artifacts, ledger, clock);
  const input = {
    ...exact("record-push-reconciliation"), original_operation_id: original.record.operationId,
    original_head_sha: HEAD_SHA, original_tree_sha: TREE_SHA,
    observation_operation_id: observation.record.operationId,
    expected_original_state_sha256: original.stateSha256,
    expected_observation_state_sha256: observation.stateSha256, dry_run: false
  };
  return { tasks, git, github, ledger, artifacts, clock, remote, exact, service, input,
    original, observation, originalBytes, observationBytes };
}

describe("versioned PUSH readback reconciliation", () => {
  test("the actual MCP boundary preserves strict fields, default inspection and append refinements", async () => {
    const reconcilePush = vi.fn().mockImplementation(async (args: Record<string, unknown>) => ({
      ok: true, schema: "push-readback-reconciliation.v1", operation_id: args.operation_id,
      repo_id: args.repo_id, task_id: args.task_id, head_sha: HEAD_SHA, tree_sha: TREE_SHA,
      original_operation_id: args.original_operation_id, original_state_sha256: "a".repeat(64),
      observation_operation_id: args.observation_operation_id, observation_state_sha256: "b".repeat(64),
      observation_evidence_sha256: "c".repeat(64), publication: "EXACT_PUBLICATION_CONFIRMED",
      original_push_outcome: "UNKNOWN", original_fence_preserved: true, push_replayed: false,
      dry_run: true, recorded: false, artifact: null, warnings: []
    }));
    const server = createMcpServer({ registry: { taskBinding: () => undefined }, lifecycle: { reconcilePush } } as unknown as RuntimeContext);
    const client = new Client({ name: "reconciliation-wire-fixture", version: "1" });
    const pair = InMemoryTransport.createLinkedPair();
    await server.connect(pair[0]);
    await client.connect(pair[1]);
    try {
      const listed = (await client.listTools()).tools.find(tool => tool.name === "repo_write_push_reconciliation")!;
      expect(listed.inputSchema.additionalProperties).toBe(false);
      const input = { operation_id: "wire-inspection", repo_id: FIXED_TASK.repoId, task_id: FIXED_TASK.taskId,
        expected_head_sha: HEAD_SHA, expected_tree_sha: TREE_SHA, original_operation_id: "original-push",
        original_head_sha: HEAD_SHA, original_tree_sha: TREE_SHA, observation_operation_id: "later-observation" };
      for (const forbidden of [{ force: true }, { dry_run: false }, { dry_run: false, expected_original_state_sha256: "a".repeat(64) }]) {
        expect((await client.callTool({ name: listed.name, arguments: { ...input, ...forbidden } })).isError).toBe(true);
        expect(reconcilePush).not.toHaveBeenCalled();
      }
      await client.callTool({ name: listed.name, arguments: input });
      expect(reconcilePush).toHaveBeenCalledExactlyOnceWith({ ...input, dry_run: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test.each([false, true])("confirms publication (later=%s) without claiming original push success or changing its fence", async later => {
    const f = await setup(later);
    const before = f.ledger.records.size;
    const preview = await f.service.reconcilePush({ ...f.input, dry_run: true });
    expect(preview.operation).toBeUndefined();
    expect(f.ledger.records.size).toBe(before);
    const result = await f.service.reconcilePush(f.input);
    expect(result.record).toMatchObject({
      schema: "push-readback-reconciliation.v1",
      publication: later ? "LATER_PUBLICATION_CONFIRMED" : "EXACT_PUBLICATION_CONFIRMED",
      originalPushOutcome: "UNKNOWN", originalFencePreserved: true, pushReplayed: false
    });
    expect(await f.service.resolves(FIXED_TASK, f.original.record, f.input.expected_head_sha, f.input.expected_tree_sha)).toBe(true);
    expect(JSON.stringify(await f.ledger.readExact(f.input.original_operation_id))).toBe(f.originalBytes);
    expect(JSON.stringify(await f.ledger.readExact(f.input.observation_operation_id))).toBe(f.observationBytes);
    expect(f.git.pushCalls).toBe(1); // Only the original fixture push; reconciliation never invokes it.
    expect(await f.remote.writePush({ ...f.exact("original-unknown-push"), expected_head_sha: HEAD_SHA, expected_tree_sha: TREE_SHA }))
      .toMatchObject({ disposition: "STORED", operation: { phase: "UNKNOWN_AFTER_CONTACT" } });
    expect(f.git.pushCalls).toBe(1);
  });

  test("requires explicit state bindings for append, rejects arbitrary selectors, and defaults to inspect", () => {
    const minimal = {
      operation_id: "inspect-publication", repo_id: "repo-1", task_id: "task-1",
      expected_head_sha: HEAD_SHA, expected_tree_sha: TREE_SHA, original_operation_id: "original-push",
      original_head_sha: HEAD_SHA, original_tree_sha: TREE_SHA, observation_operation_id: "observed-remote"
    };
    expect(RepoWritePushReconciliationInputSchema.parse(minimal).dry_run).toBe(true);
    expect(RepoWritePushReconciliationInputSchema.safeParse({ ...minimal, dry_run: false }).success).toBe(false);
    for (const extra of ["force", "branch", "url", "root", "provider", "result", "approval_id"]) {
      expect(RepoWritePushReconciliationInputSchema.safeParse({ ...minimal, [extra]: "unsafe" }).success).toBe(false);
    }
  });

  test.each(["diverged", "wrong-merge-base", "unavailable"])("requires authoritative ancestry, not local claims: %s", async kind => {
    const f = await setup(true);
    vi.spyOn(f.github, "compare").mockImplementation(async () => {
      if (kind === "unavailable") throw new Error("fixture compare unavailable");
      return { status: kind === "diverged" ? "diverged" : "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: BASE_SHA };
    });
    await expect(f.service.reconcilePush(f.input)).rejects.toBeDefined();
    expect(f.ledger.records.has(f.input.operation_id)).toBe(false);
  });

  test.each(["local", "original", "observation"])("rejects mid-read drift in %s", async kind => {
    const f = await setup();
    const getRef = f.github.getRef.bind(f.github);
    vi.spyOn(f.github, "getRef").mockImplementation(async (...args) => {
      const result = await getRef(...args);
      if (kind === "local") f.git.snapshot.clean = false;
      else f.ledger.records.get(kind === "original" ? f.input.original_operation_id : f.input.observation_operation_id)!.updatedAt = f.clock.now().toISOString();
      return result;
    });
    await expect(f.service.reconcilePush(f.input)).rejects.toBeDefined();
    expect(f.ledger.records.has(f.input.operation_id)).toBe(false);
  });

  test("missing exact-state or artifact identity capabilities cannot discharge an unknown", async () => {
    const f = await setup();
    const withoutState = Object.create(f.ledger) as MemoryOperationLedger;
    Object.defineProperty(withoutState, "readExact", { value: undefined });
    const unavailable = new GitHubPushReconciliationService(f.tasks, f.git, f.github, f.artifacts, withoutState, f.clock);
    await expect(unavailable.reconcilePush(f.input)).rejects.toMatchObject({ code: "PUSH_RECONCILIATION_LEDGER_UNAVAILABLE" });
    const withoutArtifact = Object.create(f.artifacts) as MemoryArtifactSink;
    Object.defineProperty(withoutArtifact, "getExactJson", { value: undefined });
    const noIdentity = new GitHubPushReconciliationService(f.tasks, f.git, f.github, withoutArtifact, f.ledger, f.clock);
    await expect(noIdentity.reconcilePush(f.input)).rejects.toMatchObject({ code: "PUSH_RECONCILIATION_ARTIFACT_CAPABILITY_UNAVAILABLE" });
    expect(f.ledger.records.has(f.input.operation_id)).toBe(false);
  });

  test("concurrent exact duplicates return the same immutable record and never replay push", async () => {
    const f = await setup();
    const results = await Promise.all([f.service.reconcilePush(f.input), f.service.reconcilePush(f.input)]);
    expect(results[0]!.record).toEqual(results[1]!.record);
    expect(results.filter(result => result.stored)).toHaveLength(1);
    expect(f.git.pushCalls).toBe(1);
    await expect(f.service.reconcilePush({ ...f.input, expected_original_state_sha256: "f".repeat(64) }))
      .rejects.toMatchObject({ code: "PUSH_RECONCILIATION_STATE_DRIFT" });
  });

  test.each([
    "original-digest", "observation-digest", "head", "tree", "other-task", "other-effect",
    "other-failure", "precontact", "earlier", "equal-time", "future", "missing-operation",
    "missing-evidence", "tampered-evidence", "wrong-artifact-id", "remote-head", "remote-tree",
    "remote-name", "credential-url", "repository-id", "repository-name", "permission", "archived", "ancestry", "dirty"
  ])("fails closed before append: %s", async kind => {
    const f = await setup();
    const original = f.ledger.records.get(f.input.original_operation_id)!;
    const observation = f.ledger.records.get(f.input.observation_operation_id)!;
    const observedResult = observation.result as Record<string, JsonValue>;
    if (kind === "original-digest") f.input.expected_original_state_sha256 = "f".repeat(64);
    if (kind === "observation-digest") f.input.expected_observation_state_sha256 = "f".repeat(64);
    if (kind === "head") f.input.original_head_sha = BASE_SHA;
    if (kind === "tree") f.input.original_tree_sha = BASE_TREE_SHA;
    if (kind === "other-task") original.taskId = "another-task";
    if (kind === "other-effect") original.semantic = "repo_write_merge";
    if (kind === "other-failure") original.failureCode = "UNSUPPORTED";
    if (kind === "precontact") original.phase = "FAILED_PRECONTACT";
    if (kind === "earlier") observation.createdAt = "2026-08-22T00:00:00.000Z";
    if (kind === "equal-time") observation.createdAt = original.updatedAt;
    if (kind === "future") observation.updatedAt = "2027-01-01T00:00:00.000Z";
    if (kind === "missing-operation") f.ledger.records.delete(f.input.observation_operation_id);
    if (kind === "missing-evidence") f.artifacts.values.clear();
    if (kind === "tampered-evidence") f.artifacts.values.set("github-remote-evidence:" + String(observedResult.artifactDigest), {});
    if (kind === "wrong-artifact-id") observedResult.artifactId = "artifact_wrongidentity";
    if (kind === "remote-head") f.github.refs.set("refs/heads/" + FIXED_TASK.branch, BASE_SHA);
    if (kind === "remote-tree") f.github.refTrees.set("refs/heads/" + FIXED_TASK.branch, BASE_TREE_SHA);
    if (kind === "remote-name") f.git.snapshot.pushUrls = ["https://github.com/elsewhere/project.git"];
    if (kind === "credential-url") f.git.snapshot.pushUrls = ["https://user:fixture@github.com/example/project.git"];
    if (kind === "repository-id") f.github.repository.id = "R_other";
    if (kind === "repository-name") f.github.repository.nameWithOwner = "another/project";
    if (kind === "permission") f.github.repository.viewerPermission = "READ";
    if (kind === "archived") f.github.repository.archived = true;
    if (kind === "ancestry") f.git.ancestorResolver = () => false;
    if (kind === "dirty") f.git.snapshot.clean = false;
    // Bind deliberately changed fixture records to exercise semantic checks, not only stale hashes.
    if (!kind.endsWith("digest")) {
      f.input.expected_original_state_sha256 = (await f.ledger.readExact(f.input.original_operation_id))!.stateSha256;
      f.input.expected_observation_state_sha256 = (await f.ledger.readExact(f.input.observation_operation_id))?.stateSha256 ?? "f".repeat(64);
    }
    await expect(f.service.reconcilePush(f.input)).rejects.toBeDefined();
    expect(f.ledger.records.has(f.input.operation_id)).toBe(false);
    expect(f.git.pushCalls).toBe(1);
  });

  test.each(["secret", "path", "unknown-field", "wrong-repository", "wrong-branch", "wrong-tree"])(
    "rejects even correctly hashed native observation data with %s drift", async kind => {
      const f = await setup();
      const op = f.ledger.records.get(f.input.observation_operation_id)!;
      const result = op.result as Record<string, JsonValue>;
      const key = "github-remote-evidence:" + String(result.artifactDigest);
      const value = structuredClone(f.artifacts.values.get(key)!) as Record<string, JsonValue>;
      if (kind === "secret") value.localUpstream = ["ghp", "_", "x".repeat(36)].join("");
      if (kind === "path") value.localUpstream = "/Users/private/data";
      if (kind === "unknown-field") value.override = true;
      if (kind === "wrong-repository") value.repoId = "another-repo";
      if (kind === "wrong-branch") value.branch = "another/branch";
      if (kind === "wrong-tree") value.remoteTreeSha = BASE_TREE_SHA;
      const hash = sha256Json(value);
      const stored = await f.artifacts.putJson({ namespace: "github-remote-evidence", digest: hash, value, mode: 0o600 });
      result.artifactDigest = hash;
      result.artifactId = stored.artifactId;
      f.input.expected_observation_state_sha256 = (await f.ledger.readExact(op.operationId))!.stateSha256;
      await expect(f.service.reconcilePush(f.input)).rejects.toBeDefined();
      expect(f.ledger.records.has(f.input.operation_id)).toBe(false);
    }
  );

  test.each(["write", "readback", "post-write-drift"])("does not adopt evidence after %s failure", async kind => {
    const f = await setup();
    const originalPut = f.artifacts.putJson.bind(f.artifacts);
    vi.spyOn(f.artifacts, "putJson").mockImplementation(async input => {
      if (input.namespace !== "github-push-evidence") return originalPut(input);
      if (kind === "write") throw new Error("fixture write failed");
      const result = await originalPut(input);
      if (kind === "readback") f.artifacts.values.delete(input.namespace + ":" + input.digest);
      if (kind === "post-write-drift") f.github.refs.set("refs/heads/" + FIXED_TASK.branch, BASE_SHA);
      return result;
    });
    await expect(f.service.reconcilePush(f.input)).rejects.toBeDefined();
    expect(f.ledger.records.get(f.input.operation_id)?.phase).toBe("BLOCKED");
    expect(await f.service.resolves(FIXED_TASK, f.original.record, HEAD_SHA, TREE_SHA)).toBe(false);
    expect(JSON.stringify(await f.ledger.readExact(f.input.original_operation_id))).toBe(f.originalBytes);
    expect(f.git.pushCalls).toBe(1);
  });

  test("keeps stale, tampered, downgraded and interrupted append records ineligible", async () => {
    const f = await setup();
    const result = await f.service.reconcilePush(f.input);
    expect(await f.service.resolves(FIXED_TASK, f.original.record, BASE_SHA, BASE_TREE_SHA)).toBe(false);
    const operation = f.ledger.records.get(f.input.operation_id)!;
    const saved = structuredClone(operation);
    operation.phase = "LOCAL_MUTATION_STARTED";
    expect(await f.service.resolves(FIXED_TASK, f.original.record, HEAD_SHA, TREE_SHA)).toBe(false);
    f.ledger.records.set(saved.operationId, saved);
    const key = "github-push-evidence:" + result.evidence!.digest;
    const record = structuredClone(f.artifacts.values.get(key)!) as Record<string, JsonValue>;
    record.schema = "push-readback-reconciliation.v0";
    f.artifacts.values.set(key, record);
    expect(await f.service.resolves(FIXED_TASK, f.original.record, HEAD_SHA, TREE_SHA)).toBe(false);
    expect(f.git.pushCalls).toBe(1);
  });

  test("merge and review resolution consume validated append evidence without waiving other gates", async () => {
    const f = await setup();
    const evidence = new FixedMergeEvidenceProvider();
    const ci = new GitHubCiService(f.tasks, f.git, f.github, f.artifacts, f.ledger, f.clock);
    const gate = new GitHubMergeGateService(f.tasks, f.git, f.github, ci, evidence, f.artifacts, f.ledger, f.clock, undefined, f.service);
    const review = new GitHubReviewService(f.tasks, f.git, f.github, evidence, f.artifacts, f.ledger, f.clock, f.service);
    expect(await gate.mergeGatePrepare(f.exact("gate-before-reconciliation")))
      .toMatchObject({ eligible: false, blockers: expect.arrayContaining([{ code: "UNKNOWN_EXTERNAL_EFFECT", message: expect.any(String) }]) });
    await f.service.reconcilePush(f.input);
    const qualified = await gate.mergeGatePrepare(f.exact("gate-after-reconciliation"));
    expect(qualified).toMatchObject({ eligible: true, manifest: { independentReviewRequired: true } });
    expect(f.github.calls).not.toContain("mergePullRequest");
    f.github.reviewThreads = [makeReviewThread()];
    await review.prReviewThreads(f.exact("snapshot-after-reconciliation"));
    await expect(review.writePrResolveThread({ ...f.exact("resolve-without-reply"), thread_id: "thread_1",
      expected_thread_updated_at: f.github.reviewThreads[0]!.updatedAt })).rejects.toBeDefined();
    f.clock.advance(1000);
    await review.writePrReply({ ...f.exact("reply-after-reconciliation"), thread_id: "thread_1", body: "Verified at the same head." });
    f.clock.advance(1000);
    evidence.validation.createdAt = f.clock.now().toISOString();
    const resolved = await review.writePrResolveThread({ ...f.exact("resolve-after-reconciliation"), thread_id: "thread_1",
      expected_thread_updated_at: f.github.reviewThreads[0]!.updatedAt });
    expect(resolved).toMatchObject({ thread: { isResolved: true } });
    evidence.review.status = "failed";
    expect(await gate.mergeGatePrepare(f.exact("gate-review-still-required"))).toMatchObject({ eligible: false });
    const competing: GitHubOperationRecord = { ...f.original.record, operationId: "unknown-non-push", semantic: "repo_write_merge" };
    f.ledger.records.set(competing.operationId, competing);
    expect(await gate.mergeGatePrepare(f.exact("gate-other-unknown-still-blocked")))
      .toMatchObject({ eligible: false, blockers: expect.arrayContaining([{ code: "UNKNOWN_EXTERNAL_EFFECT", message: expect.any(String) }]) });
    expect(f.git.pushCalls).toBe(1);
  });

  test("final manifest readback and review resolution reject evidence lost after preparation", async () => {
    const f = await setup();
    const evidence = new FixedMergeEvidenceProvider();
    const ci = new GitHubCiService(f.tasks, f.git, f.github, f.artifacts, f.ledger, f.clock);
    const gate = new GitHubMergeGateService(f.tasks, f.git, f.github, ci, evidence, f.artifacts, f.ledger, f.clock, undefined, f.service);
    const review = new GitHubReviewService(f.tasks, f.git, f.github, evidence, f.artifacts, f.ledger, f.clock, f.service);
    const appended = await f.service.reconcilePush(f.input);
    const prepared = await gate.mergeGatePrepare(f.exact("gate-retained-evidence"));
    if (prepared.disposition !== "EXECUTED" || !prepared.manifest) throw new Error("Fixture manifest missing");
    const manifest = prepared.manifest;
    expect(await gate.loadAndRevalidateExactManifest(manifest)).toMatchObject({ headSha: HEAD_SHA });
    f.github.reviewThreads = [makeReviewThread()];
    await review.prReviewThreads(f.exact("snapshot-retained-evidence"));
    f.artifacts.values.delete("github-push-evidence:" + appended.evidence!.digest);
    await expect(gate.loadAndRevalidateExactManifest(manifest)).rejects.toBeDefined();
    await expect(review.writePrResolveThread({ ...f.exact("resolve-lost-evidence"), thread_id: "thread_1",
      expected_thread_updated_at: f.github.reviewThreads[0]!.updatedAt })).rejects.toMatchObject({ code: "UNKNOWN_EXTERNAL_EFFECT" });
    expect(f.github.calls).not.toContain("mergePullRequest");
    expect(f.github.reviewThreads[0]!.isResolved).toBe(false);
  });
});
