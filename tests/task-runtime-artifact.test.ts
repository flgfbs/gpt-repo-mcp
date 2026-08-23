import { mkdtemp, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  casPath,
  TaskArtifactKindSchema,
  TaskArtifactStore,
  toTaskArtifactPublicReference
} from "../src/task-runtime/artifact-store.js";
import { hashedDiskKey } from "../src/task-runtime/canonical-json.js";
import type { TaskState } from "../src/task-runtime/contracts.js";
import { CrossProcessLockManager } from "../src/task-runtime/cross-process-lock.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";
import { TaskStateStore } from "../src/task-runtime/state-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task-scoped content-addressed artifacts", () => {
  test("uses the exact stable artifact kind vocabulary", () => {
    expect(TaskArtifactKindSchema.options).toEqual([
      "task_manifest",
      "operation_receipt",
      "validation_log",
      "large_diff",
      "remote_observation",
      "push_receipt",
      "pull_request",
      "review_evidence",
      "ci_evidence",
      "merge_gate_evidence",
      "merge_receipt",
      "post_merge_evidence"
    ]);
  });

  test("returns opaque ids, verifies content digests, and serves bounded ranges", async () => {
    const { artifacts, store } = await fixture();
    await store.writeTask(taskInput("task-alpha"));
    const metadata = await artifacts.put({
      task_id: "task-alpha",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "evidence/output.txt",
      content: "0123456789"
    });
    expect(metadata.artifact_id).toMatch(/^artifact_[0-9a-f]{32}$/);
    expect(metadata.artifact_id).not.toContain(metadata.content_sha256);
    expect(toTaskArtifactPublicReference(metadata)).toEqual({
      artifact_id: metadata.artifact_id,
      kind: metadata.kind,
      media_type: metadata.media_type,
      content_sha256: metadata.content_sha256,
      byte_length: metadata.byte_length
    });
    const range = await artifacts.read({ task_id: "task-alpha", artifact_id: metadata.artifact_id, offset: 3, length: 4 });
    expect(Buffer.from(range.content_base64, "base64").toString("utf8")).toBe("3456");
    expect(range).toMatchObject({ offset: 3, length: 4, total_bytes: 10, eof: false });
    expect((await stat(store.fs.absolutePath(casPath(metadata.content_sha256)))).mode & 0o777).toBe(0o600);
    expect(await artifacts.listMetadata("task-alpha")).toEqual([metadata]);
    await expect(artifacts.read({ task_id: "task-alpha", artifact_id: metadata.artifact_id, length: 9 }))
      .rejects.toMatchObject({ code: "ARTIFACT_RANGE_INVALID" });
  });

  test("denies artifact ids across tasks without revealing global CAS contents", async () => {
    const { artifacts, store } = await fixture();
    await store.writeTask(taskInput("task-alpha"));
    await store.writeTask(taskInput("task-beta"));
    const metadata = await artifacts.put({
      task_id: "task-alpha",
      kind: "validation_log",
      media_type: "text/plain",
      logical_path: "logs/worker.txt",
      content: "safe log"
    });
    await expect(artifacts.read({ task_id: "task-beta", artifact_id: metadata.artifact_id }))
      .rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
  });

  test("blocks secret candidates, invalid media, and unsafe logical paths", async () => {
    const { artifacts, store } = await fixture();
    await store.writeTask(taskInput("task-safe"));
    await expect(artifacts.put({
      task_id: "task-safe",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "logs/output.txt",
      content: ["api_key=", "unit-test-secret-value"].join("")
    })).rejects.toMatchObject({ code: "ARTIFACT_SECRET_BLOCKED" });
    await expect(artifacts.put({
      task_id: "task-safe",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "../escape.txt",
      content: "safe"
    })).rejects.toMatchObject({ code: "RUNTIME_PATH_UNSAFE" });
    await expect(artifacts.put({
      task_id: "task-safe",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "./evidence.txt",
      content: "safe"
    })).rejects.toMatchObject({ code: "ARTIFACT_TYPE_BLOCKED" });
    await expect(artifacts.put({
      task_id: "task-safe",
      kind: "review_evidence",
      media_type: "application/json",
      logical_path: "evidence/result.json",
      content: "not-json"
    })).rejects.toMatchObject({ code: "ARTIFACT_TYPE_BLOCKED" });
  });

  test("fails closed when CAS bytes are replaced by a symlink", async () => {
    const { parent, artifacts, store } = await fixture();
    await store.writeTask(taskInput("task-link"));
    const metadata = await artifacts.put({
      task_id: "task-link",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "evidence/link.txt",
      content: "original"
    });
    const contentPath = store.fs.absolutePath(casPath(metadata.content_sha256));
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "original", { mode: 0o600 });
    await unlink(contentPath);
    await symlink(outside, contentPath);
    await expect(artifacts.read({ task_id: "task-link", artifact_id: metadata.artifact_id }))
      .rejects.toMatchObject({ code: "RUNTIME_FILE_UNSAFE" });
  });

  test("fails closed on a symlink in the bounded artifact metadata listing", async () => {
    const { parent, artifacts, store } = await fixture();
    await store.writeTask(taskInput("task-list-link"));
    await artifacts.put({
      task_id: "task-list-link",
      kind: "review_evidence",
      media_type: "text/plain",
      logical_path: "evidence/list.txt",
      content: "safe"
    });
    const outside = join(parent, "outside-metadata.json");
    await writeFile(outside, "{}", { mode: 0o600 });
    const metadataDirectory = store.fs.absolutePath(`tasks/${hashedDiskKey("task", "task-list-link")}/artifacts`);
    await symlink(outside, join(metadataDirectory, `${"f".repeat(64)}.json`));
    await expect(artifacts.listMetadata("task-list-link")).rejects.toMatchObject({ code: "TASK_STATE_TAMPERED" });
  });
});

async function fixture(): Promise<{ parent: string; store: TaskStateStore; artifacts: TaskArtifactStore }> {
  const parent = await mkdtemp(join(tmpdir(), "task-artifact-test-"));
  roots.push(parent);
  const fs = new SecureRuntimeFs(join(parent, "runtime"));
  const store = new TaskStateStore(fs);
  await store.initialize();
  const locks = new CrossProcessLockManager(fs, { timeoutMs: 2_000, pollMs: 5 });
  const artifacts = new TaskArtifactStore(store, locks, { maxArtifactBytes: 1024, maxRangeBytes: 8 });
  return { parent, store, artifacts };
}

function taskInput(taskId: string): Omit<TaskState, "state_sha256"> {
  const timestamp = new Date().toISOString();
  return {
    schema_version: 1,
    task_id: taskId,
    repo_id: `task-${hashedDiskKey("repo", taskId).slice(0, 40)}`,
    base_repo_id: "owner",
    base_branch: "main",
    base_commit: "1".repeat(40),
    base_tree: "2".repeat(40),
    authority: "implement",
    goal: "Exercise artifacts.",
    branch_slug: "artifact-test",
    server_branch: `chat-pro/tasks/artifact-test-${hashedDiskKey("task-worktree", taskId).slice(0, 12)}`,
    worktree_path: `/tmp/artifact-${taskId}`,
    lifecycle: "OPEN",
    worktree_state: "PRESENT",
    branch_state: "PRESENT",
    worktree_head: "1".repeat(40),
    worktree_tree: "2".repeat(40),
    registration_state: "REGISTERED",
    close_disposition: null,
    closed_at: null,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp
  };
}
