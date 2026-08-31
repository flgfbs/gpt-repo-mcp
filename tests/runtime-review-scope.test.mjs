import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { describe, expect, test } from "vitest";
import {
  SCOPE_DEFINITION_PATH,
  buildScopeDefinition,
  canonicalJson,
  emitPacketScope,
  readAndValidateScopeDefinition,
  sha256Bytes
} from "../scripts/runtime-review-scope.mjs";

const FIXTURE_ENTRIES = [
  { path: "src/runtime.ts", role: "runtime_source" },
  { path: "tests/runtime.test.ts", role: "runtime_test" }
];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-review-scope-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, dirname(SCOPE_DEFINITION_PATH)), { recursive: true });
  await writeFile(join(root, "src/runtime.ts"), "export const runtime = true;\n");
  await writeFile(join(root, "tests/runtime.test.ts"), "export const covered = true;\n");
  const definition = await buildScopeDefinition(root, FIXTURE_ENTRIES);
  await writeDefinition(root, definition);
  return { definition, root };
}

async function writeDefinition(root, definition) {
  await writeFile(
    join(root, SCOPE_DEFINITION_PATH),
    `${JSON.stringify(definition, null, 2)}\n`,
    "utf8"
  );
}

async function expectScopeError(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("provider-free runtime review scope", () => {
  test("validates the committed repository definition", async () => {
    const definition = await readAndValidateScopeDefinition(process.cwd());
    expect(definition.scope_id).toBe("provider-free-execution-runtime-v2");
    expect(definition.epoch_kind).toBe("NEW_INDEPENDENT_SCOPE_EPOCH");
    expect(definition.superseded_target).toMatchObject({
      disposition: "PERMANENTLY_BLOCKED_MISSING_CANONICAL_SCOPE_BINDING",
      head_sha: "08197744a4b2e11fa50d0c56ecf892b92b9dd1ce",
      relation_to_new_scope: "NOT_ASSERTED"
    });
  });

  test("builds deterministic definitions and emits a self-containing packet scope", async () => {
    const { definition, root } = await createFixture();
    try {
      expect(await buildScopeDefinition(root, FIXTURE_ENTRIES)).toEqual(definition);
      expect(await readAndValidateScopeDefinition(root, FIXTURE_ENTRIES)).toEqual(definition);

      const packetScope = await emitPacketScope(
        root,
        "1".repeat(40),
        "2".repeat(40),
        FIXTURE_ENTRIES
      );
      expect(packetScope).toMatchObject({
        schema: "review-scope-manifest.v1",
        target_head: "1".repeat(40),
        target_tree: "2".repeat(40)
      });
      expect(packetScope.entries.map(({ path }) => path)).toEqual([
        SCOPE_DEFINITION_PATH,
        "src/runtime.ts",
        "tests/runtime.test.ts"
      ]);
      const { scope_sha256: observed, ...core } = packetScope;
      expect(observed).toBe(sha256Bytes(canonicalJson(core)));
      expect(packetScope.entries.find(({ path }) => path === SCOPE_DEFINITION_PATH)?.object_sha256)
        .toBe(sha256Bytes(await readFile(join(root, SCOPE_DEFINITION_PATH))));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a scoped file drifts or disappears", async () => {
    const { root } = await createFixture();
    try {
      await writeFile(join(root, "src/runtime.ts"), "export const runtime = false;\n");
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_FILE_DIGEST_MISMATCH"
      );
      await rm(join(root, "src/runtime.ts"));
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_FILE_MISSING"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects tampered, duplicate, and noncanonical definitions", async () => {
    const { definition, root } = await createFixture();
    try {
      const tampered = structuredClone(definition);
      tampered.entries[0].object_sha256 = "0".repeat(64);
      await writeDefinition(root, tampered);
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_DEFINITION_DIGEST_MISMATCH"
      );

      const duplicate = structuredClone(definition);
      duplicate.entries[1].path = duplicate.entries[0].path;
      await writeDefinition(root, duplicate);
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_ENTRY_DUPLICATE"
      );

      const unsorted = structuredClone(definition);
      unsorted.entries.reverse();
      await writeDefinition(root, unsorted);
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_ENTRIES_NONCANONICAL"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects policy metadata tampering even after its digest is recomputed", async () => {
    const { definition, root } = await createFixture();
    try {
      const tampered = structuredClone(definition);
      tampered.superseded_target.historical_packet_sha256 = "f".repeat(64);
      const core = { ...tampered };
      delete core.definition_sha256;
      tampered.definition_sha256 = sha256Bytes(canonicalJson(core));
      await writeDefinition(root, tampered);
      await expectScopeError(
        readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
        "SCOPE_DEFINITION_POLICY_MISMATCH"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid explicit target bindings", async () => {
    const { root } = await createFixture();
    try {
      await expectScopeError(
        emitPacketScope(root, "not-a-head", "2".repeat(40), FIXTURE_ENTRIES),
        "TARGET_GIT_BINDING_INVALID"
      );
      await expectScopeError(
        emitPacketScope(root, "1".repeat(40), "not-a-tree", FIXTURE_ENTRIES),
        "TARGET_GIT_BINDING_INVALID"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
