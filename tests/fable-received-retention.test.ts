import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FableLauncherPort } from "../src/services/fable-launcher-port.js";
import { FableReceivedStore, receivedFablePath } from "../src/services/fable-received-store.js";
import { buildFableReviewPreparation, canonicalFableScope, targetFromInput } from "../src/services/fable-review-packet.js";
import { SecretScanner } from "../src/services/secret-scanner.js";
import { commitTaskChange, FakeFableLauncher, initialInput, managedTaskFixture, type TaskFixture } from "./fixtures/fable-review-fixture.js";

const fixtures: TaskFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await rm(fixture.parent, { recursive: true, force: true });
});

async function setup(operationId: string) {
  const fixture = await managedTaskFixture();
  fixtures.push(fixture);
  const committed = await commitTaskChange(fixture.taskRoot, "reviewed.ts", "export const value = 1;\n");
  const input = initialInput(fixture, committed, operationId);
  const launcher = new FakeFableLauncher(["REVISE"]);
  const store = new FableReceivedStore(fixture.bundle.tasks.fs);
  return { fixture, input, launcher, store };
}

// Real Git worktrees and durable fsync/readback are slower than pure unit tests.
describe("managed response retention before review adoption", { timeout: 30_000 }, () => {
  test("keeps the exact sanitized REVISE after receipt rejection without granting review authority", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-receipt-failure");
    const invoke = launcher.invoke.bind(launcher);
    vi.spyOn(launcher, "invoke").mockImplementation(async prepared => {
      const result = await invoke(prepared);
      result.receipt_readback = { ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED" };
      return result;
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    expect(result.review_result).toBeUndefined();
    const received = await store.read(input);
    expect(received).toMatchObject({
      verification_state: "UNVERIFIED_NOT_REVIEW_AUTHORITY",
      operation_id: input.operation_id,
      received_review: { review_status: "REVISE" }
    });
    expect(JSON.parse(received.response!)).toEqual(received.received_review);
    const encoded = JSON.stringify(received);
    for (const value of ["sensitive-route-marker", "sensitive-model-marker", "sensitive-location-marker", "packet_bytes", "request_path", "attestation"]) {
      expect(encoded).not.toContain(value);
    }
    const operation = await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id);
    expect(operation).toMatchObject({ phase: "FAILED_KNOWN_AFTER_CONTACT", effect_state: "PARTIAL" });
    await expect(fixture.service(launcher).run(input)).rejects.toMatchObject({ code: "TASK_OPERATION_CONFLICT" });
    const blocked = await fixture.service(launcher).run({ ...input, operation_id: "operation-retain-no-new-initial" });
    expect(blocked.outcome_code).toBe("STOP_MANAGED_REVIEW_REPLAY_BLOCKED");
    expect(launcher.invocationCount).toBe(1);
  });

  test("requires both response retention and final artifact readback before terminal success", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-order");
    const put = fixture.bundle.artifacts.put.bind(fixture.bundle.artifacts);
    vi.spyOn(fixture.bundle.artifacts, "put").mockImplementation(async value => {
      const operation = await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id);
      expect(operation?.phase).toBe("EXTERNAL_PRECONTACT");
      expect((await store.read(input)).received_review.review_status).toBe("REVISE");
      return put(value);
    });
    const read = fixture.bundle.artifacts.read.bind(fixture.bundle.artifacts);
    vi.spyOn(fixture.bundle.artifacts, "read").mockImplementation(async value => {
      const operation = await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id);
      expect(operation?.phase).toBe("EXTERNAL_PRECONTACT");
      return read(value);
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "review_completed", review_result: { review_status: "REVISE" } });
    expect(await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id))
      .toMatchObject({ phase: "EXTERNAL_SUCCEEDED", effect_state: "PRESENT" });
    expect(launcher.invocationCount).toBe(1);
  });

  test.each(["write", "read"] as const)("does not report completion after final artifact %s failure", async mode => {
    const { fixture, input, launcher, store } = await setup(`operation-retain-artifact-${mode}`);
    if (mode === "write") vi.spyOn(fixture.bundle.artifacts, "put").mockRejectedValueOnce(new Error("disk unavailable"));
    else vi.spyOn(fixture.bundle.artifacts, "read").mockRejectedValueOnce(new Error("readback unavailable"));
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({
      review_state: "contacted_incomplete", provider_contact: "YES",
      outcome_code: "STOP_MANAGED_ARTIFACT_RETENTION_FAILED"
    });
    expect(result.artifact).toBeUndefined();
    expect(result.review_result).toBeUndefined();
    expect((await store.read(input)).received_review.review_status).toBe("REVISE");
    expect(await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id))
      .toMatchObject({ phase: "FAILED_KNOWN_AFTER_CONTACT", effect_state: "PARTIAL" });
    expect(launcher.invocationCount).toBe(1);
  });

  test("retains known contact when the first response record cannot be written", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-disk-failure");
    const write = fixture.bundle.tasks.fs.atomicWrite.bind(fixture.bundle.tasks.fs);
    vi.spyOn(fixture.bundle.tasks.fs, "atomicWrite").mockImplementation(async (path, bytes, options) => {
      if (path.startsWith("fable-received/")) throw new Error("disk unavailable");
      return write(path, bytes, options);
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES",
      outcome_code: "STOP_MANAGED_RECEIVED_RETENTION_FAILED" });
    expect(result.review_result).toBeUndefined();
    await expect(store.read(input)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launcher.invocationCount).toBe(1);
  });

  test("keeps received records immutable and allows operation-bound reads after HEAD changes", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-historical");
    const result = await fixture.service(launcher).run(input);
    const before = await store.read(input);
    const storedPath = fixture.bundle.tasks.fs.absolutePath(receivedFablePath(input.task_id, input.operation_id));
    const bytes = await readFile(storedPath);
    const target = targetFromInput(input);
    const preparation = await buildFableReviewPreparation({ request: input, target,
      scope: canonicalFableScope(input, target), root: fixture.taskRoot, scanner: new SecretScanner() });
    await expect(store.retain(input, preparation, {
      review_result: before.received_review, response: before.response, invocation_id: before.attempt_id
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(storedPath)).toEqual(bytes);
    await expect(store.assertFresh(input)).rejects.toThrow("STOP_MANAGED_RECEIVED_RECORD_ALREADY_EXISTS");
    await commitTaskChange(fixture.taskRoot, "reviewed.ts", "export const value = 2;\n");
    expect(await store.read(input)).toEqual(before);
    await expect(store.read({ ...input, repo_id: "wrong-task-repo" })).rejects.toThrow("STOP_MANAGED_RECEIVED_BINDING_MISMATCH");
    expect(result.target.head_sha).toBe(input.expected_head_sha);
    expect(launcher.invocationCount).toBe(1);
  });

  test("does not retain suspected credentials or arbitrary launcher fields", async () => {
    const { fixture, input, store } = await setup("operation-retain-secret");
    const launcher = new FakeFableLauncher(["OUTPUT_BLOCKED"]);
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES",
      outcome_code: "STOP_MANAGED_REVIEW_OUTPUT_BLOCKED" });
    await expect(store.read(input)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain(["ghp", "_"].join(""));
    expect(launcher.invocationCount).toBe(1);
  });

  test("detects response readback corruption and keeps the contact consumed", async () => {
    const { fixture, input, launcher } = await setup("operation-retain-corruption");
    const write = fixture.bundle.tasks.fs.atomicWrite.bind(fixture.bundle.tasks.fs);
    vi.spyOn(fixture.bundle.tasks.fs, "atomicWrite").mockImplementation(async (path, bytes, options) => {
      await write(path, bytes, options);
      if (path.startsWith("fable-received/")) {
        await writeFile(fixture.bundle.tasks.fs.absolutePath(path), "synthetic corruption");
      }
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES",
      outcome_code: "STOP_MANAGED_RECEIVED_RETENTION_FAILED" });
    expect(result.review_result).toBeUndefined();
    expect(launcher.invocationCount).toBe(1);
  });

  test("historical reads reject unsafe permissions without silently changing them", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-private-read");
    await fixture.service(launcher).run(input);
    const file = fixture.bundle.tasks.fs.absolutePath(receivedFablePath(input.task_id, input.operation_id));
    const original = await readFile(file);
    await chmod(dirname(file), 0o755);
    await expect(store.read(input)).rejects.toThrow("STOP_MANAGED_RECEIVED_DIRECTORY_UNSAFE");
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o755);
    expect(await readFile(file)).toEqual(original);
  });

  test("a published but unadopted artifact cannot authorize focused rereview", async () => {
    const { fixture, input, launcher } = await setup("operation-retain-unadopted");
    vi.spyOn(fixture.bundle.artifacts, "read").mockRejectedValueOnce(new Error("publication readback failed"));
    const result = await fixture.service(launcher).run(input);
    expect(result.review_state).toBe("contacted_incomplete");
    const metadata = await fixture.bundle.artifacts.listMetadata(fixture.taskId);
    const unadopted = metadata.find(item => item.logical_path === `reviews/fable/${result.lineage!.epoch_id}.json`)!;
    expect(unadopted).toBeDefined();
    const head = await commitTaskChange(fixture.taskRoot, "reviewed.ts", "export const value = 2;\n");
    const focused = await fixture.service(launcher).run({
      ...input, operation_id: "operation-retain-unadopted-focused",
      expected_head_sha: head.head, expected_tree_sha: head.tree,
      review_kind: "focused_rereview", scope: { kind: "focused_paths", paths: ["reviewed.ts"] },
      prior_review_artifact_id: unadopted.artifact_id
    });
    expect(focused).toMatchObject({ review_state: "failed_precontact", provider_contact: "NO",
      outcome_code: "STOP_MANAGED_PRIOR_REVIEW_NOT_ELIGIBLE" });
    expect(launcher.invocationCount).toBe(1);
  });

  test("preserves known contact and received evidence when the launcher throws after observation", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-post-observation-error");
    const invoke = launcher.invoke.bind(launcher);
    vi.spyOn(launcher as FableLauncherPort, "invoke").mockImplementation(async (prepared, onReceived) => {
      const invocation = await invoke(prepared);
      await onReceived?.(invocation.payload);
      throw new Error("synthetic local failure after received payload");
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    expect(result.review_result).toBeUndefined();
    expect((await store.read(input)).received_review.review_status).toBe("REVISE");
    expect(await fixture.bundle.tasks.states.readOperation(fixture.taskId, input.operation_id))
      .toMatchObject({ phase: "FAILED_KNOWN_AFTER_CONTACT", effect_state: "PARTIAL" });
    expect(await fixture.service(launcher).run({ ...input, operation_id: "operation-no-replay-after-observation" }))
      .toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED" });
    expect(launcher.invocationCount).toBe(1);
  });

  test("does not mislabel a post-callback Git-refresh failure as precontact", async () => {
    const { fixture, input, launcher, store } = await setup("operation-retain-refresh-failure");
    const withState = fixture.bundle.tasks.runWithExactTaskState.bind(fixture.bundle.tasks);
    vi.spyOn(fixture.bundle.tasks, "runWithExactTaskState").mockImplementation(async (binding, action) => {
      await withState(binding, action);
      throw new Error("post-callback refresh failed");
    });
    const result = await fixture.service(launcher).run(input);
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    expect((await store.read(input)).received_review.review_status).toBe("REVISE");
    expect(launcher.invocationCount).toBe(1);
  });
});
