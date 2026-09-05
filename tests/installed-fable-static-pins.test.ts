import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InstalledTypedFableLauncher } from "../src/services/installed-fable-launcher.js";
import { runProcessWithTail } from "../src/services/process-exec.js";
import type { InstalledStaticPin } from "../src/services/installed-fable-static-pins.js";

const state = vi.hoisted(() => ({
  home: "",
  pins: {} as Record<string, InstalledStaticPin>,
  checked: [] as Array<{ path: string; expected: unknown }>
}));

vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => {
    if (!state.home) throw new Error("synthetic home not bound");
    return state.home;
  }
}));
vi.mock("../src/services/process-exec.js", () => ({ runProcessWithTail: vi.fn() }));
vi.mock("../src/services/installed-fable-static-pins.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/services/installed-fable-static-pins.js")>();
  return {
    ...actual,
    // Only the expected bytes are substituted for tiny provider-free fixtures.
    // The production adapter path selection and real descriptor checker run.
    assertPinnedStaticFile: async (path: string, expected: unknown) => {
      state.checked.push({ path, expected });
      const synthetic = state.pins[basename(path)];
      if (!synthetic) throw new Error("unbound synthetic file");
      await actual.assertPinnedStaticFile(path, synthetic);
    }
  };
});

const actual = await vi.importActual<typeof import("../src/services/installed-fable-static-pins.js")>(
  "../src/services/installed-fable-static-pins.js"
);
const SUPPORT = [
  "task_prior_archive.py",
  "review_response_retention_bootstrap.py",
  "review_lineage_reconciliation.py",
  "route-policy.json",
  "resolver_registry.py"
] as const;
const EXECUTABLES = ["typed_fable_launcher.py", "claude_review_router.py"] as const;
const STOP = "STOP_MANAGED_INSTALLED_BYTES_MISMATCH";
const roots: string[] = [];
const runProcess = vi.mocked(runProcessWithTail);

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(): Promise<{ home: string; installed: string }> {
  // Never derive this root from the real home or installed runtime.
  const home = await mkdtemp(join(tmpdir(), "mcp-static-pin-test-"));
  roots.push(home);
  const installed = join(home, ".codex", "external-model-adapters", "claude-review-router");
  await mkdir(installed, { recursive: true, mode: 0o700 });
  state.home = home;
  for (const name of [...EXECUTABLES, ...SUPPORT]) {
    const bytes = Buffer.from("# provider-free synthetic " + name + "\n");
    const mode = name === "route-policy.json" ? 0o600
      : name === "resolver_registry.py" ? 0o644 : 0o700;
    state.pins[name] = { name, byte_length: bytes.length, sha256: sha(bytes), mode };
    await writeFile(join(installed, name), bytes, { mode });
  }
  return { home, installed };
}

function described(): string {
  const schemas = [2, 3, 4, 5, 6].map(version => "claude-review-router-typed-launch.v" + version);
  return JSON.stringify({
    supported_request_schemas: schemas,
    provider_contacts_per_launcher_invocation_max: Object.fromEntries(schemas.map(value =>
      [value, value.endsWith(".v3") ? 2 : 1])),
    automatic_successor_per_launcher_invocation: Object.fromEntries(schemas.map(value =>
      [value, value.endsWith(".v3") ? "PRE_MODEL_HTTP_529_ONCE" : "DISABLED"])),
    automatic_fallback: "DISABLED", automatic_retry: "DISABLED",
    credential_mutation: "PROHIBITED", provider_contacts_per_attempt: 1,
    provider_contacts_per_router_attempt: 1,
    packet_output_contract_preflight: "CANONICAL_SCHEMA_REQUIRED_WHEN_EXPLICIT",
    default_output_carrier: "TEXT_JSON", output_carriers: ["PLAIN_MARKDOWN", "TEXT_JSON"],
    required_capability_class: "FABLE", required_reasoning: "MAX",
    valid_semantic_results_per_review_epoch: 1
  });
}

beforeEach(() => {
  state.home = "";
  state.pins = {};
  state.checked = [];
  runProcess.mockReset();
  runProcess.mockResolvedValue({
    exit_code: 0, timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: "",
    captured_output: { stdout: described(), stderr: "", truncated: false }
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("closed installed Fable static support pins", () => {
  test("has exactly five source-bound production dependencies", async () => {
    expect(actual.FABLE_STATIC_DEPENDENCY_PINS.map(pin => pin.name)).toEqual(SUPPORT);
    for (const pin of actual.FABLE_STATIC_DEPENDENCY_PINS) {
      expect(pin.byte_length).toBeGreaterThan(0);
      expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pin.mode).toBe(pin.name === "route-policy.json" ? 0o600
        : pin.name === "resolver_registry.py" ? 0o644 : 0o700);
    }
    expect(runProcess).not.toHaveBeenCalled();
  });

  test("checks all seven fixed files before the one describe process", async () => {
    const f = await fixture();
    const before = new Map(await Promise.all([...EXECUTABLES, ...SUPPORT].map(async name =>
      [name, await readFile(join(f.installed, name))] as const)));
    runProcess.mockImplementationOnce(async () => {
      expect(state.checked.map(value => basename(value.path)).sort())
        .toEqual([...EXECUTABLES, ...SUPPORT].sort());
      return {
        exit_code: 0, timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: "",
        captured_output: { stdout: described(), stderr: "", truncated: false }
      };
    });
    await expect(new InstalledTypedFableLauncher().preflight()).resolves.toMatchObject({
      request_schema: "claude-review-router-typed-launch.v2",
      provider_contact_limit: 1, model_class: "FABLE", reasoning: "MAX"
    });
    expect(runProcess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executable: join(f.installed, "typed_fable_launcher.py"), args: ["describe"], cwd: f.installed
    }));
    for (const [name, bytes] of before) expect(await readFile(join(f.installed, name))).toEqual(bytes);
  });

  for (const name of SUPPORT) {
    test.each(["missing", "tampered", "mode", "symlink", "hardlink"] as const)(
      name + " rejects %s before describe or invoke", async kind => {
        const f = await fixture();
        const path = join(f.installed, name);
        const original = await readFile(path);
        if (kind === "missing") await rm(path);
        if (kind === "tampered") {
          const changed = Buffer.from(original);
          changed[0] = changed[0] === 33 ? 34 : 33;
          await writeFile(path, changed);
        }
        if (kind === "mode") await chmod(path, 0o666);
        if (kind === "symlink") {
          const saved = join(f.home, "same-byte-source");
          await rename(path, saved);
          await symlink(saved, path);
        }
        if (kind === "hardlink") await link(path, join(f.home, "same-byte-alias"));
        await expect(new InstalledTypedFableLauncher().preflight()).rejects.toThrow(STOP);
        expect(runProcess).not.toHaveBeenCalled();
      }
    );
  }

  test.each(EXECUTABLES)("keeps the existing %s executable pin boundary", async name => {
    const f = await fixture();
    await chmod(join(f.installed, name), 0o600);
    await expect(new InstalledTypedFableLauncher().preflight()).rejects.toThrow(STOP);
    expect(runProcess).not.toHaveBeenCalled();
  });

  test.each([0o600, 0o644, 0o700] as const)("accepts only the exact fixed mode %i", async mode => {
    const f = await fixture();
    const path = join(f.installed, "resolver_registry.py");
    const pin = { ...state.pins["resolver_registry.py"]!, mode };
    await chmod(path, mode);
    await expect(actual.assertPinnedStaticFile(path, pin)).resolves.toBeUndefined();
    await chmod(path, mode === 0o700 ? 0o644 : 0o700);
    await expect(actual.assertPinnedStaticFile(path, pin)).rejects.toThrow(STOP);
    expect(runProcess).not.toHaveBeenCalled();
  });

  test.each([
    { byte_length: 0, sha256: "0".repeat(64), mode: 0o700 },
    { byte_length: null, sha256: null, mode: null },
    { byte_length: -1, sha256: "a".repeat(64), mode: 0o700 },
    { byte_length: 2 * 1024 * 1024 + 1, sha256: "a".repeat(64), mode: 0o700 },
    { byte_length: 1, sha256: "NOT_BOUND", mode: 0o700 },
    { byte_length: 1, sha256: "A".repeat(64), mode: 0o700 }
  ] satisfies Array<Omit<InstalledStaticPin, "name">>)("fails closed on invalid or unbound pin %j", async pin => {
    await expect(actual.assertPinnedStaticFile("/synthetic/not-read", pin)).rejects.toThrow(STOP);
    expect(runProcess).not.toHaveBeenCalled();
  });

  test("rejects same-length wrong digest without modifying the input", async () => {
    const f = await fixture();
    const path = join(f.installed, "task_prior_archive.py");
    const before = await readFile(path);
    await expect(actual.assertPinnedStaticFile(path, {
      ...state.pins["task_prior_archive.py"]!, sha256: "0".repeat(64)
    })).rejects.toThrow(STOP);
    expect(await readFile(path)).toEqual(before);
  });
});
