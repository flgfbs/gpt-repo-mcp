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
  "native_history_migration.py",
  "managed_missing_body_admission.py",
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
  const schemas = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(version => "claude-review-router-typed-launch.v" + version);
  const boundedSchemas = schemas.filter(schema => !schema.endsWith(".v8") && !schema.endsWith(".v9"));
  return JSON.stringify({
    supported_request_schemas: schemas,
    provider_contacts_per_launcher_invocation_max: Object.fromEntries(boundedSchemas.map(value =>
      [value, value.endsWith(".v3") ? 2 : 1])),
    automatic_successor_per_launcher_invocation: Object.fromEntries(boundedSchemas.map(value =>
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
  test("has exactly seven source-bound production dependencies", async () => {
    expect(actual.FABLE_STATIC_DEPENDENCY_PINS.map(pin => pin.name)).toEqual(SUPPORT);
    for (const pin of actual.FABLE_STATIC_DEPENDENCY_PINS) {
      expect(pin.byte_length).toBeGreaterThan(0);
      expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(pin.mode).toBe(pin.name === "route-policy.json" ? 0o600
        : pin.name === "resolver_registry.py" ? 0o644 : 0o700);
    }
    expect(runProcess).not.toHaveBeenCalled();
  });

  test("checks all nine fixed files before the one describe process", async () => {
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
      managed_missing_body_request_schema: "claude-review-router-typed-launch.v7",
      provider_contact_limit: 1, model_class: "FABLE", reasoning: "MAX"
    });
    expect(runProcess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executable: join(f.installed, "typed_fable_launcher.py"), args: ["describe"], cwd: f.installed
    }));
    for (const [name, bytes] of before) expect(await readFile(join(f.installed, name))).toEqual(bytes);
  });

  test("binds the guarded source cohort while retaining only managed v2 and v7", async () => {
    await fixture();
    const result = await new InstalledTypedFableLauncher().preflight();
    expect(result).toEqual({
      launcher_sha256: "345c3508dc8cfdcf9af741c7a3917c920d1a18462e13d11c8544c745331da902",
      router_sha256: "1ad06682f51e6b476d872f377d78dd65360a1590421092cc3d85c2db87ef21fd",
      request_schema: "claude-review-router-typed-launch.v2",
      managed_missing_body_request_schema: "claude-review-router-typed-launch.v7",
      provider_contact_limit: 1, model_class: "FABLE", reasoning: "MAX"
    });
    expect(result).not.toHaveProperty("native_migration_request_schema");
    expect(actual.FABLE_STATIC_DEPENDENCY_PINS.find(pin => pin.name === "native_history_migration.py"))
      .toEqual({ name: "native_history_migration.py", byte_length: 66854,
        sha256: "51f0749cd5b78c5ab0954beb74c16f3df78ba991000a1e227906e077d549f620", mode: 0o700 });
    expect(actual.FABLE_STATIC_DEPENDENCY_PINS.find(pin => pin.name === "review_response_retention_bootstrap.py"))
      .toEqual({ name: "review_response_retention_bootstrap.py", byte_length: 140764,
        sha256: "fc235cb55230e0055b2be3ff8790bc12742d3f04d681b83fc0b95284d9fae958", mode: 0o700 });
  });

  test("legacy describe never implies managed recovery capability", async () => {
    await fixture();
    const value = JSON.parse(described());
    value.supported_request_schemas = value.supported_request_schemas.filter(
      (schema: string) => !schema.endsWith(".v7"));
    runProcess.mockResolvedValueOnce({
      exit_code: 0, timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: "",
      captured_output: { stdout: JSON.stringify(value), stderr: "", truncated: false }
    });
    const result = await new InstalledTypedFableLauncher().preflight();
    expect(result.request_schema).toBe("claude-review-router-typed-launch.v2");
    expect(result).not.toHaveProperty("managed_missing_body_request_schema");
    expect(runProcess).toHaveBeenCalledOnce();
  });

  test.each(["generic_limit", "missing_limit", "multiple_contacts", "missing_successor", "enabled_successor"] as const)(
    "v7 rejects %s before preparation or provider contact", async kind => {
      await fixture();
      const value = JSON.parse(described());
      const schema = "claude-review-router-typed-launch.v7";
      if (kind === "generic_limit") value.provider_contacts_per_launcher_invocation_max = 1;
      if (kind === "missing_limit") delete value.provider_contacts_per_launcher_invocation_max[schema];
      if (kind === "multiple_contacts") value.provider_contacts_per_launcher_invocation_max[schema] = 2;
      if (kind === "missing_successor") delete value.automatic_successor_per_launcher_invocation[schema];
      if (kind === "enabled_successor") value.automatic_successor_per_launcher_invocation[schema] = "PRE_MODEL_HTTP_529_ONCE";
      runProcess.mockResolvedValueOnce({
        exit_code: 0, timed_out: false, duration_ms: 0, stdout_tail: "", stderr_tail: "",
        captured_output: { stdout: JSON.stringify(value), stderr: "", truncated: false }
      });
      await expect(new InstalledTypedFableLauncher().preflight())
        .rejects.toThrow("STOP_MANAGED_LAUNCHER_CONTRACT_MISMATCH");
      expect(runProcess).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ args: ["describe"] }));
    }
  );

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
