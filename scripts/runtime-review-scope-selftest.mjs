import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SCOPE_DEFINITION_PATH,
  buildScopeDefinition,
  canonicalJson,
  emitPacketScope,
  readAndValidateScopeDefinition,
  sha256Bytes
} from "./runtime-review-scope.mjs";

const FIXTURE_ENTRIES = [
  { path: "src/runtime.ts", role: "runtime_source" },
  { path: "tests/runtime.test.ts", role: "runtime_test" }
];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-review-scope-selftest-"));
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

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code);
}

async function successCase() {
  const { definition, root } = await createFixture();
  try {
    assert.deepEqual(await buildScopeDefinition(root, FIXTURE_ENTRIES), definition);
    assert.deepEqual(await readAndValidateScopeDefinition(root, FIXTURE_ENTRIES), definition);
    const first = await emitPacketScope(root, "1".repeat(40), "2".repeat(40), FIXTURE_ENTRIES);
    const second = await emitPacketScope(root, "1".repeat(40), "2".repeat(40), FIXTURE_ENTRIES);
    assert.deepEqual(first, second);
    assert.deepEqual(first.entries.map(({ path }) => path), [
      SCOPE_DEFINITION_PATH,
      "src/runtime.ts",
      "tests/runtime.test.ts"
    ]);
    const { scope_sha256: observed, ...core } = first;
    assert.equal(observed, sha256Bytes(canonicalJson(core)));
    assert.equal(
      first.entries.find(({ path }) => path === SCOPE_DEFINITION_PATH)?.object_sha256,
      sha256Bytes(await readFile(join(root, SCOPE_DEFINITION_PATH)))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fileDriftCase() {
  const { root } = await createFixture();
  try {
    await writeFile(join(root, "src/runtime.ts"), "export const runtime = false;\n");
    await expectCode(
      () => readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
      "SCOPE_FILE_DIGEST_MISMATCH"
    );
    await rm(join(root, "src/runtime.ts"));
    await expectCode(
      () => readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
      "SCOPE_FILE_MISSING"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function tamperCase() {
  const { definition, root } = await createFixture();
  try {
    const rehashedPolicyTamper = structuredClone(definition);
    rehashedPolicyTamper.superseded_target.historical_packet_sha256 = "f".repeat(64);
    const core = { ...rehashedPolicyTamper };
    delete core.definition_sha256;
    rehashedPolicyTamper.definition_sha256 = sha256Bytes(canonicalJson(core));
    await writeDefinition(root, rehashedPolicyTamper);
    await expectCode(
      () => readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
      "SCOPE_DEFINITION_POLICY_MISMATCH"
    );

    const duplicate = structuredClone(definition);
    duplicate.entries[1].path = duplicate.entries[0].path;
    await writeDefinition(root, duplicate);
    await expectCode(
      () => readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
      "SCOPE_ENTRY_DUPLICATE"
    );

    const noncanonical = structuredClone(definition);
    noncanonical.entries.reverse();
    await writeDefinition(root, noncanonical);
    await expectCode(
      () => readAndValidateScopeDefinition(root, FIXTURE_ENTRIES),
      "SCOPE_ENTRIES_NONCANONICAL"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function targetBindingCase() {
  const { root } = await createFixture();
  try {
    await expectCode(
      () => emitPacketScope(root, "invalid", "2".repeat(40), FIXTURE_ENTRIES),
      "TARGET_GIT_BINDING_INVALID"
    );
    await expectCode(
      () => emitPacketScope(root, "1".repeat(40), "invalid", FIXTURE_ENTRIES),
      "TARGET_GIT_BINDING_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await successCase();
await fileDriftCase();
await tamperCase();
await targetBindingCase();
process.stdout.write("Runtime review scope self-test passed.\n");
