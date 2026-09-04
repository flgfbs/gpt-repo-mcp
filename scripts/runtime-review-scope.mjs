import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const SCOPE_DEFINITION_PATH = "docs/review-scopes/provider-free-execution-runtime-v2.json";
export const SCOPE_DEFINITION_SCHEMA = "provider-free-execution-runtime-review-scope-definition.v1";
export const PACKET_SCOPE_SCHEMA = "review-scope-manifest.v1";
export const SCOPE_ID = "provider-free-execution-runtime-v2";
export const EPOCH_KIND = "NEW_INDEPENDENT_SCOPE_EPOCH";

const EXCLUSIONS = Object.freeze([
  "provider contact and independent-review execution",
  "runtime behavior changes",
  "live worker or supervisor activation",
  "historical packet reconstruction",
  "AIDCP source changes"
]);
const MATERIALIZATION_BASE = Object.freeze({
  head_sha: "c4b1b6e731d0a1794e22ffa2739050f63480e1a9",
  tree_sha: "e83817ad64d43541f9f8eb5a1ec084dc15bab914"
});
const REVIEW_CONTRACT = Object.freeze({
  automatic_fallback: false,
  epoch_relation: "fresh_initial",
  packet_scope_schema: PACKET_SCOPE_SCHEMA,
  provider_contact_authority: "SEPARATE_EXACT_GATE",
  runtime_behavior_change: false
});
const SUPERSEDED_TARGET = Object.freeze({
  disposition: "PERMANENTLY_BLOCKED_MISSING_CANONICAL_SCOPE_BINDING",
  head_sha: "08197744a4b2e11fa50d0c56ecf892b92b9dd1ce",
  historical_packet_sha256: "25f7714f0cffe77657e8ff4ae074e8fd2de0a68a6f612c2abd079fe8cebf4490",
  historical_receipt_sha256: "7079b28a677322720215a2398818c138fe6dba240a31cbaaefcd244559797226",
  historical_scope_sha256: "430766b8dc1db3051bebd927bf0694f57946292f8bb40892183b4db15435d673",
  implementation_base_sha: "8206aa23bb132c51f75fabf2028a8bc1642ba75d",
  relation_to_new_scope: "NOT_ASSERTED",
  tree_sha: "f5b17a5d47f4337af423a4005154a636224f0eac"
});

const HEX_40 = /^[a-f0-9]{40}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const ROLES = new Set(["architecture", "runtime_source", "runtime_test", "scope_control", "validation"]);
const DEFINITION_KEYS = [
  "definition_sha256",
  "entries",
  "epoch_kind",
  "exclusions",
  "materialization_base",
  "review_contract",
  "schema",
  "scope_id",
  "superseded_target"
].sort();
const ENTRY_KEYS = ["object_sha256", "path", "role"].sort();

export const REVIEW_ENTRIES = Object.freeze([
  { path: "CHANGELOG.md", role: "architecture" },
  { path: "README.md", role: "architecture" },
  { path: "docs/ARCHITECTURE.md", role: "architecture" },
  { path: "docs/CAPABILITIES.md", role: "architecture" },
  { path: "docs/CHATGPT_CONNECT.md", role: "architecture" },
  { path: "docs/DELEGATION_ARTIFACTS.md", role: "architecture" },
  { path: "docs/MIGRATION.md", role: "architecture" },
  { path: "docs/PRODUCT.md", role: "architecture" },
  { path: "docs/QUALITY.md", role: "architecture" },
  { path: "docs/RELEASE_CHECKLIST.md", role: "architecture" },
  { path: "docs/TOOL_SURFACE.md", role: "architecture" },
  { path: "package.json", role: "scope_control" },
  { path: "scripts/runtime-review-scope-selftest.mjs", role: "scope_control" },
  { path: "scripts/runtime-review-scope.mjs", role: "scope_control" },
  { path: "scripts/smoke-dist-server.mjs", role: "validation" },
  { path: "src/contracts/agent-runs.contract.ts", role: "runtime_source" },
  { path: "src/contracts/task-admission.contract.ts", role: "runtime_source" },
  { path: "src/delegation/artifact-contracts.ts", role: "runtime_source" },
  { path: "src/delegation/dispatch-store.ts", role: "runtime_source" },
  { path: "src/delegation/execution-runtime-contracts.ts", role: "runtime_source" },
  { path: "src/delegation/queue-supervisor.ts", role: "runtime_source" },
  { path: "src/delegation/safe-artifact.ts", role: "runtime_source" },
  { path: "src/delegation/supervisor-store.ts", role: "runtime_source" },
  { path: "src/services/agent-runs-service.ts", role: "runtime_source" },
  { path: "src/services/delegation-execution-runtime.ts", role: "runtime_source" },
  { path: "src/services/lifecycle-factory.ts", role: "runtime_source" },
  { path: "src/services/lifecycle-runtime.ts", role: "runtime_source" },
  { path: "src/services/repository-lifecycle-runtime.ts", role: "runtime_source" },
  { path: "src/services/task-admission-service.ts", role: "runtime_source" },
  { path: "src/tools/contracts.ts", role: "runtime_source" },
  { path: "src/tools/descriptions.ts", role: "runtime_source" },
  { path: "src/tools/handlers/lifecycle.ts", role: "runtime_source" },
  { path: "src/tools/oss-tool-profile.ts", role: "runtime_source" },
  { path: "src/tools/packages/lifecycle.ts", role: "runtime_source" },
  { path: "src/tools/registry.ts", role: "runtime_source" },
  { path: "tests/agent-runs-service.test.ts", role: "runtime_test" },
  { path: "tests/delegation-queue-supervisor.test.ts", role: "runtime_test" },
  { path: "tests/fixtures/delegation-v3-run-fixture.ts", role: "runtime_test" },
  { path: "tests/lifecycle-tool-contracts.test.ts", role: "runtime_test" },
  { path: "tests/package-scripts.test.ts", role: "runtime_test" },
  { path: "tests/repository-lifecycle-runtime.test.ts", role: "runtime_test" },
  { path: "tests/runtime-review-scope.test.mjs", role: "scope_control" },
  { path: "tests/task-admission-service.test.ts", role: "runtime_test" },
  { path: "tests/tool-contracts.test.ts", role: "runtime_test" },
  { path: "tests/workflow-drift-guard.test.ts", role: "runtime_test" }
]);

export class ReviewScopeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ReviewScopeError";
    this.code = code;
  }
}

export function canonicalJson(value) {
  return encodeCanonical(value, new Set());
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function buildScopeDefinition(root, entrySpecs = REVIEW_ENTRIES) {
  const normalizedSpecs = normalizeEntrySpecs(entrySpecs);
  const entries = [];
  for (const entry of normalizedSpecs) {
    const bytes = await readBoundRegularFile(root, entry.path);
    entries.push({
      object_sha256: sha256Bytes(bytes),
      path: entry.path,
      role: entry.role
    });
  }
  const core = {
    entries,
    epoch_kind: EPOCH_KIND,
    exclusions: [...EXCLUSIONS],
    materialization_base: { ...MATERIALIZATION_BASE },
    review_contract: { ...REVIEW_CONTRACT },
    schema: SCOPE_DEFINITION_SCHEMA,
    scope_id: SCOPE_ID,
    superseded_target: { ...SUPERSEDED_TARGET }
  };
  return {
    ...core,
    definition_sha256: sha256Bytes(canonicalJson(core))
  };
}

export async function validateScopeDefinition(root, definition, entrySpecs = REVIEW_ENTRIES) {
  assertPlainObject(definition, "SCOPE_DEFINITION_INVALID");
  assertExactKeys(definition, DEFINITION_KEYS, "SCOPE_DEFINITION_INVALID");
  if (
    definition.schema !== SCOPE_DEFINITION_SCHEMA
    || definition.scope_id !== SCOPE_ID
    || definition.epoch_kind !== EPOCH_KIND
  ) {
    throw new ReviewScopeError("SCOPE_DEFINITION_IDENTITY_MISMATCH");
  }
  if (
    canonicalJson(definition.exclusions) !== canonicalJson(EXCLUSIONS)
    || canonicalJson(definition.materialization_base) !== canonicalJson(MATERIALIZATION_BASE)
    || canonicalJson(definition.review_contract) !== canonicalJson(REVIEW_CONTRACT)
    || canonicalJson(definition.superseded_target) !== canonicalJson(SUPERSEDED_TARGET)
  ) {
    throw new ReviewScopeError("SCOPE_DEFINITION_POLICY_MISMATCH");
  }
  if (!Array.isArray(definition.entries)) {
    throw new ReviewScopeError("SCOPE_ENTRIES_INVALID");
  }
  const expectedSpecs = normalizeEntrySpecs(entrySpecs);
  if (definition.entries.length !== expectedSpecs.length) {
    throw new ReviewScopeError("SCOPE_ENTRY_SET_MISMATCH");
  }
  const seen = new Set();
  const normalizedEntries = [];
  for (let index = 0; index < definition.entries.length; index += 1) {
    const entry = definition.entries[index];
    assertPlainObject(entry, "SCOPE_ENTRY_INVALID");
    assertExactKeys(entry, ENTRY_KEYS, "SCOPE_ENTRY_INVALID");
    validateSafeRelativePath(entry.path);
    if (!ROLES.has(entry.role) || !HEX_64.test(entry.object_sha256)) {
      throw new ReviewScopeError("SCOPE_ENTRY_INVALID");
    }
    if (seen.has(entry.path)) {
      throw new ReviewScopeError("SCOPE_ENTRY_DUPLICATE");
    }
    seen.add(entry.path);
    const expected = expectedSpecs[index];
    if (entry.path !== expected.path || entry.role !== expected.role) {
      throw new ReviewScopeError("SCOPE_ENTRIES_NONCANONICAL");
    }
    normalizedEntries.push({
      object_sha256: entry.object_sha256,
      path: entry.path,
      role: entry.role
    });
  }
  const core = {
    entries: normalizedEntries,
    epoch_kind: definition.epoch_kind,
    exclusions: definition.exclusions,
    materialization_base: definition.materialization_base,
    review_contract: definition.review_contract,
    schema: definition.schema,
    scope_id: definition.scope_id,
    superseded_target: definition.superseded_target
  };
  const expectedDefinitionSha256 = sha256Bytes(canonicalJson(core));
  if (definition.definition_sha256 !== expectedDefinitionSha256) {
    throw new ReviewScopeError("SCOPE_DEFINITION_DIGEST_MISMATCH");
  }
  for (const entry of normalizedEntries) {
    const bytes = await readBoundRegularFile(root, entry.path);
    if (sha256Bytes(bytes) !== entry.object_sha256) {
      throw new ReviewScopeError("SCOPE_FILE_DIGEST_MISMATCH", `Scope file drifted: ${entry.path}`);
    }
  }
  return definition;
}

export async function readAndValidateScopeDefinition(root, entrySpecs = REVIEW_ENTRIES) {
  const bytes = await readBoundRegularFile(root, SCOPE_DEFINITION_PATH);
  let definition;
  try {
    definition = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ReviewScopeError("SCOPE_DEFINITION_JSON_INVALID");
  }
  return validateScopeDefinition(root, definition, entrySpecs);
}

export async function emitPacketScope(root, targetHead, targetTree, entrySpecs = REVIEW_ENTRIES) {
  if (!HEX_40.test(targetHead) || !HEX_40.test(targetTree)) {
    throw new ReviewScopeError("TARGET_GIT_BINDING_INVALID");
  }
  const definition = await readAndValidateScopeDefinition(root, entrySpecs);
  const definitionBytes = await readBoundRegularFile(root, SCOPE_DEFINITION_PATH);
  const entries = [
    ...definition.entries.map(({ object_sha256, path }) => ({ object_sha256, path })),
    {
      object_sha256: sha256Bytes(definitionBytes),
      path: SCOPE_DEFINITION_PATH
    }
  ].sort((left, right) => (
    compareText(left.path, right.path)
    || compareText(left.object_sha256, right.object_sha256)
  ));
  const core = {
    entries,
    schema: PACKET_SCOPE_SCHEMA,
    target_head: targetHead,
    target_tree: targetTree
  };
  return {
    ...core,
    scope_sha256: sha256Bytes(canonicalJson(core))
  };
}

export async function writeScopeDefinition(root, entrySpecs = REVIEW_ENTRIES) {
  const definition = await buildScopeDefinition(root, entrySpecs);
  await mkdir(resolve(root, dirname(SCOPE_DEFINITION_PATH)), { recursive: true });
  const destination = resolve(root, SCOPE_DEFINITION_PATH);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644
    });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return definition;
}

function normalizeEntrySpecs(entrySpecs) {
  if (!Array.isArray(entrySpecs) || entrySpecs.length === 0) {
    throw new ReviewScopeError("SCOPE_ENTRY_SET_EMPTY");
  }
  const normalized = entrySpecs.map((entry) => {
    assertPlainObject(entry, "SCOPE_ENTRY_SPEC_INVALID");
    validateSafeRelativePath(entry.path);
    if (!ROLES.has(entry.role)) {
      throw new ReviewScopeError("SCOPE_ENTRY_SPEC_INVALID");
    }
    return { path: entry.path, role: entry.role };
  });
  const sorted = [...normalized].sort((left, right) => (
    compareText(left.path, right.path) || compareText(left.role, right.role)
  ));
  if (canonicalJson(normalized) !== canonicalJson(sorted)) {
    throw new ReviewScopeError("SCOPE_ENTRY_SPECS_NONCANONICAL");
  }
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) {
    throw new ReviewScopeError("SCOPE_ENTRY_SPEC_DUPLICATE");
  }
  if (normalized.some(({ path }) => path === SCOPE_DEFINITION_PATH)) {
    throw new ReviewScopeError("SCOPE_DEFINITION_SELF_REFERENCE");
  }
  return normalized;
}

async function readBoundRegularFile(root, path) {
  validateSafeRelativePath(path);
  const canonicalRoot = await realpath(resolve(root));
  const absolute = resolve(canonicalRoot, path);
  const relativePath = relative(canonicalRoot, absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new ReviewScopeError("SCOPE_PATH_ESCAPE");
  }
  let stat;
  try {
    stat = await lstat(absolute);
  } catch {
    throw new ReviewScopeError("SCOPE_FILE_MISSING", `Missing scope file: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ReviewScopeError("SCOPE_FILE_TYPE_INVALID", `Unsafe scope file: ${path}`);
  }
  const canonicalFile = await realpath(absolute);
  const rebound = relative(canonicalRoot, canonicalFile);
  if (rebound === ".." || rebound.startsWith(`..${sep}`) || isAbsolute(rebound)) {
    throw new ReviewScopeError("SCOPE_PATH_ESCAPE");
  }
  return readFile(canonicalFile);
}

function validateSafeRelativePath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\\")
    || isAbsolute(path)
    || path.startsWith("/")
    || path.endsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ReviewScopeError("SCOPE_PATH_INVALID");
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertPlainObject(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ReviewScopeError(code);
  }
}

function assertExactKeys(value, expected, code) {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(expected)) {
    throw new ReviewScopeError(code);
  }
}

function encodeCanonical(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReviewScopeError("CANONICAL_JSON_NONFINITE");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return withAncestor(value, ancestors, () => `[${value.map((entry) => encodeCanonical(entry, ancestors)).join(",")}]`);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ReviewScopeError("CANONICAL_JSON_OBJECT_INVALID");
    }
    return withAncestor(value, ancestors, () => {
      const keys = Object.keys(value).sort();
      return `{${keys.map((key) => {
        const entry = value[key];
        if (entry === undefined) throw new ReviewScopeError("CANONICAL_JSON_UNDEFINED");
        return `${JSON.stringify(key)}:${encodeCanonical(entry, ancestors)}`;
      }).join(",")}}`;
    });
  }
  throw new ReviewScopeError("CANONICAL_JSON_TYPE_INVALID");
}

function withAncestor(value, ancestors, render) {
  if (ancestors.has(value)) throw new ReviewScopeError("CANONICAL_JSON_CYCLE");
  ancestors.add(value);
  try {
    return render();
  } finally {
    ancestors.delete(value);
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (command === "--write-definition" || command === "--check") {
    if (rest.length !== 0) throw new ReviewScopeError("CLI_ARGUMENT_INVALID");
    return { command };
  }
  if (command === "--emit-packet-scope") {
    const values = new Map();
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index];
      const value = rest[index + 1];
      if (!key || value === undefined || !["--target-head", "--target-tree", "--output"].includes(key) || values.has(key)) {
        throw new ReviewScopeError("CLI_ARGUMENT_INVALID");
      }
      values.set(key, value);
    }
    if (!values.has("--target-head") || !values.has("--target-tree")) {
      throw new ReviewScopeError("CLI_ARGUMENT_INVALID");
    }
    return {
      command,
      output: values.get("--output"),
      targetHead: values.get("--target-head"),
      targetTree: values.get("--target-tree")
    };
  }
  throw new ReviewScopeError("CLI_ARGUMENT_INVALID");
}

async function runCli() {
  const root = process.cwd();
  const parsed = parseCli(process.argv.slice(2));
  if (parsed.command === "--write-definition") {
    const definition = await writeScopeDefinition(root);
    process.stdout.write(`WROTE_SCOPE_DEFINITION=${definition.definition_sha256}\n`);
    return;
  }
  if (parsed.command === "--check") {
    const definition = await readAndValidateScopeDefinition(root);
    process.stdout.write(`RUNTIME_REVIEW_SCOPE=PASS\nDEFINITION_SHA256=${definition.definition_sha256}\n`);
    return;
  }
  const packetScope = await emitPacketScope(root, parsed.targetHead, parsed.targetTree);
  const output = `${JSON.stringify(packetScope, null, 2)}\n`;
  if (parsed.output) {
    validateSafeRelativePath(parsed.output);
    await writeFile(resolve(root, parsed.output), output, { encoding: "utf8", mode: 0o644 });
  } else {
    process.stdout.write(output);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    const code = error instanceof ReviewScopeError ? error.code : "UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
