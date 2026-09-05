import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FableLauncherPort, FablePayloadObserver } from "../src/services/fable-launcher-port.js";
import { FableReceivedStore } from "../src/services/fable-received-store.js";
import { InstalledTypedFableLauncher } from "../src/services/installed-fable-launcher.js";
import { runProcessWithTail, type ProcessTailResult } from "../src/services/process-exec.js";
import { commitTaskChange, FakeFableLauncher, initialInput, managedTaskFixture, type TaskFixture } from "./fixtures/fable-review-fixture.js";

vi.mock("../src/services/process-exec.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/services/process-exec.js")>();
  return { ...actual, runProcessWithTail: vi.fn(actual.runProcessWithTail) };
});
const actualProcess = await vi.importActual<typeof import("../src/services/process-exec.js")>(
  "../src/services/process-exec.js"
);
const fixtures: TaskFixture[] = [];
afterEach(async () => {
  vi.mocked(runProcessWithTail).mockReset();
  for (const f of fixtures.splice(0)) await rm(f.parent, { recursive: true, force: true });
});

type Mode = "success" | "timeout" | "signal" | "stderr-after" | "stderr-before" | "exit-failure"
  | "incomplete" | "truncated" | "invalid-utf8" | "invalid-schema" | "secret";

function childScript(payload: Record<string, unknown>, mode: Mode): string {
  const text = JSON.stringify(payload);
  let output = `Buffer.from(${JSON.stringify(text)})`;
  if (mode === "incomplete") output = `Buffer.from(${JSON.stringify(text.slice(0, -1))})`;
  // The retained prefix is valid JSON: parsing alone must not waive truncation.
  if (mode === "truncated") output = `Buffer.from(${JSON.stringify(text)} + " ".repeat(2 * 1024 * 1024))`;
  if (mode === "invalid-utf8") output = `Buffer.concat([Buffer.from('{"marker":"'), Buffer.from([255]), Buffer.from('",'), Buffer.from(${JSON.stringify(text.slice(1))})])`;
  const finish = mode === "timeout" ? "setInterval(() => {}, 1000);"
    : mode === "signal" ? 'process.kill(process.pid, "SIGTERM");'
    : mode === "exit-failure" ? "process.exitCode = 7;"
    : mode === "stderr-after" ? 'process.stderr.write("RAW_STDERR_MARKER".repeat(160000));'
    : "";
  const emit = `const emit = () => process.stdout.write(${output}, () => { ${finish} });`;
  return emit + (mode === "stderr-before"
    ? 'process.stderr.write("RAW_STDERR_MARKER".repeat(160000), emit);' : "emit();");
}

async function exercise(mode: Mode) {
  const f = await managedTaskFixture();
  fixtures.push(f);
  const committed = await commitTaskChange(f.taskRoot, "reviewed.ts", "export const value = 1;\n");
  const input = initialInput(f, committed, `operation-production-capture-${mode}`);
  const generated = new FakeFableLauncher(["REVISE"]);
  const adapter = new InstalledTypedFableLauncher();
  let processResult: ProcessTailResult | undefined;
  let receivedCalls = 0;
  let payload: Record<string, unknown> = {};
  let receiptPath = "";
  let receiptBefore = "";
  const launcher: FableLauncherPort = {
    preflight: () => generated.preflight(),
    prepare: async value => {
      const prepared = await generated.prepare(value);
      // Only synthesize fixture data here. Execution/observation use the real
      // production adapter, real subprocess capture, and real managed store.
      payload = (await generated.invoke(prepared)).payload as Record<string, unknown>;
      if (mode === "invalid-schema") {
        payload.review_result = { ...(payload.review_result as object), summary: null };
      }
      if (mode === "secret") {
        payload.review_result = {
          ...(payload.review_result as object), summary: ["ghp", "_", "x".repeat(36)].join("")
        };
      }
      const binding = payload.response_binding as { sha256: string; utf8_bytes: number };
      receiptPath = join(f.parent, payload.sanitized_diagnostic_path as string);
      receiptBefore = JSON.stringify({
        RECEIPT_SCHEMA: "claude-review-router-attempt-receipt.v2",
        INVOCATION_ID: payload.invocation_id,
        SANITIZED_DIAGNOSTIC_PATH: payload.sanitized_diagnostic_path,
        PROVIDER_CONTACT: "YES", EFFECT_DISPOSITION: "VALID_REVIEW_RESULT",
        OUTCOME_CLASS: "SUCCESS", RESULT: "REVISE", TERMINAL_TITLE_SUPPRESSION: "ACTIVE",
        AUTOMATIC_FALLBACK: "DISABLED", EXPLICIT_CONCURRENCY_LIMIT: 1,
        RESPONSE_SHA256: binding.sha256, RESPONSE_UTF8_BYTES: binding.utf8_bytes,
        review_record: payload.review_record
      });
      await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, receiptBefore, { mode: 0o600 });
      return {
        ...prepared,
        opaque_state: { installed_root: f.parent, request_path: join(f.parent, "request.json") }
      };
    },
    invoke: (prepared, observe?: FablePayloadObserver) => adapter.invoke(prepared, async value => {
      receivedCalls++;
      await observe?.(value);
    })
  };
  vi.mocked(runProcessWithTail).mockImplementation(async invocation => {
    expect(invocation).toMatchObject({
      executable: join(f.parent, "typed_fable_launcher.py"),
      cwd: f.parent, timeout_ms: 65 * 60_000, capture_bytes: 2 * 1024 * 1024
    });
    // Replace only the external executable and test deadline. Keep production
    // capture options intact; no installed files, credentials, or provider run.
    processResult = await actualProcess.runProcessWithTail({
      ...invocation, executable: process.execPath,
      args: ["-e", childScript(payload, mode)], cwd: f.parent,
      env: { PATH: process.env.PATH ?? "" }, timeout_ms: mode === "timeout" ? 1_000 : 5_000
    });
    return processResult;
  });
  const result = await f.service(launcher).run(input);
  expect(await readFile(receiptPath, "utf8")).toBe(receiptBefore);
  expect(runProcessWithTail).toHaveBeenCalledTimes(1);
  return { f, input, launcher, result, receivedCalls, processResult: processResult!,
    store: new FableReceivedStore(f.bundle.tasks.fs) };
}

describe("production adapter and subprocess capture retention", { timeout: 30_000 }, () => {
  test.each(["timeout", "signal", "stderr-after", "stderr-before", "exit-failure"] as const)(
    "retains complete stdout after %s without adopting failed execution or replaying",
    async mode => {
      const x = await exercise(mode);
      expect(x.receivedCalls).toBe(1);
      expect(x.result).toMatchObject({
        review_state: "contacted_incomplete", provider_contact: "YES"
      });
      expect(x.result.review_result).toBeUndefined();
      const retained = await x.store.read(x.input);
      expect(retained).toMatchObject({
        verification_state: "UNVERIFIED_NOT_REVIEW_AUTHORITY",
        received_review: { review_status: "REVISE" }
      });
      expect(JSON.parse(retained.response!)).toEqual(retained.received_review);
      for (const marker of ["RAW_STDERR_MARKER", "sensitive-route-marker", "sensitive-location-marker"]) {
        expect(JSON.stringify(retained)).not.toContain(marker);
        expect(JSON.stringify(x.result)).not.toContain(marker);
      }
      expect(await x.f.bundle.tasks.states.readOperation(x.f.taskId, x.input.operation_id))
        .toMatchObject({ phase: "FAILED_KNOWN_AFTER_CONTACT", effect_state: "PARTIAL" });
      if (mode === "timeout") expect(x.processResult.timed_out).toBe(true);
      if (mode === "signal") expect(x.processResult.signal).toBe("SIGTERM");
      if (mode === "exit-failure") expect(x.processResult.exit_code).toBe(7);
      if (mode.startsWith("stderr")) {
        expect(x.processResult.captured_output).toMatchObject({
          truncated: true, stdout_truncated: false, stderr_truncated: true
        });
        expect(JSON.parse(x.processResult.captured_output!.stdout).result).toBe("REVISE");
        expect(Buffer.byteLength(x.processResult.captured_output!.stderr)).toBeLessThanOrEqual(64 * 1024);
      }
      expect(await x.f.service(x.launcher).run({
        ...x.input, operation_id: `operation-production-replay-${mode}`
      })).toMatchObject({ provider_contact: "NO", outcome_code: "STOP_MANAGED_REVIEW_REPLAY_BLOCKED" });
      expect(runProcessWithTail).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["incomplete", "truncated", "invalid-utf8"] as const)(
    "does not observe or retain %s stdout, even if a truncated prefix parses",
    async mode => {
      const x = await exercise(mode);
      expect(x.receivedCalls).toBe(0);
      expect(x.result).toMatchObject({ review_state: "unknown_effect", provider_contact: "UNKNOWN" });
      expect(x.result.review_result).toBeUndefined();
      await expect(x.store.read(x.input)).rejects.toMatchObject({ code: "ENOENT" });
      if (mode === "truncated") {
        expect(JSON.parse(x.processResult.captured_output!.stdout).result).toBe("REVISE");
        expect(x.processResult.captured_output).toMatchObject({ stdout_truncated: true });
      }
    }
  );

  test.each(["invalid-schema", "secret"] as const)("never persists %s candidates or loses known contact", async mode => {
    const x = await exercise(mode);
    expect(x.receivedCalls).toBe(1);
    expect(x.result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    expect(x.result.review_result).toBeUndefined();
    await expect(x.store.read(x.input)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(x.result)).not.toContain(["ghp", "_", "x".repeat(36)].join(""));
  });

  test("still requires successful execution and exact receipt/response readback for adoption", async () => {
    const x = await exercise("success");
    expect(x.receivedCalls).toBe(1);
    expect(x.result).toMatchObject({
      review_state: "review_completed", provider_contact: "YES",
      review_result: { review_status: "REVISE" }, receipt: { retained_read_back: true }
    });
    expect((await x.store.read(x.input)).received_review.review_status).toBe("REVISE");
  });
});
