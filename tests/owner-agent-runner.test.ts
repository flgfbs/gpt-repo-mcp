import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createOwnerAgentRunnerRuntime } from "../src/owner-agent-runner.js";
import { CrossProcessLockManager } from "../src/task-runtime/cross-process-lock.js";
import { SecureRuntimeFs } from "../src/task-runtime/secure-runtime-fs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("owner agent runner", () => {
  test("holds one existing cross-process lock for the runtime lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "owner-agent-runner-"));
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const configPath = join(root, "config.local.json");
    await writeFile(configPath, `${JSON.stringify({ repos: [], limits: {}, runtime_root: runtimeRoot })}\n`, {
      mode: 0o600
    });
    await chmod(configPath, 0o600);

    const runtime = await createOwnerAgentRunnerRuntime(configPath);
    const competingLocks = new CrossProcessLockManager(new SecureRuntimeFs(runtimeRoot), {
      timeoutMs: 25,
      pollMs: 5
    });
    await expect(competingLocks.acquire("owner-agent-runner")).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });

    await runtime.close();
    await runtime.close();
    const release = await competingLocks.acquire("owner-agent-runner");
    await release();
  });
});
