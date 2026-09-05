import { readHistoricalFableReceipt } from "./fable-historical-receipt.js";
import { readNativePrivateFile, verifyNativeFableRetention } from "./fable-native-retention.js";
import { assertPinnedStaticFile, FABLE_STATIC_DEPENDENCY_PINS } from "./installed-fable-static-pins.js";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../task-runtime/canonical-json.js";
import { runProcessWithTail } from "./process-exec.js";
import { canonicalFableLauncherRequestBytes } from "./fable-launcher-port.js";
import type {
  FableLauncherInvocation,
  FableLauncherPort,
  FableLauncherPreflight,
  FablePayloadObserver,
  FableReceiptReadback,
  HistoricalFableReadbackInput,
  PreparedFableInvocation
} from "./fable-launcher-port.js";

const REQUEST_SCHEMA = "claude-review-router-typed-launch.v2" as const;
const INSTALLED_ROOT_PARTS = [".codex", "external-model-adapters", "claude-review-router"] as const;
const TRANSPORT_ROOT_PARTS = ["private", "tmp", "codex-fable-review"] as const;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MAX_LAUNCHER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LAUNCHER_STDERR_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
// Bound the entire primary invocation, not just provider execution. The pinned
// router allows 30 minutes of provider work after acquiring its serial route
// lock. Allow one such queue slot and five minutes for admission/finalization.
// This does not extend the provider timeout or authorize retries/successors.
const PRIMARY_PROVIDER_TIMEOUT_MS = 30 * 60_000;
const ROUTE_QUEUE_ALLOWANCE_MS = PRIMARY_PROVIDER_TIMEOUT_MS;
const FINALIZATION_ALLOWANCE_MS = 5 * 60_000;
const LAUNCH_TIMEOUT_MS = PRIMARY_PROVIDER_TIMEOUT_MS + ROUTE_QUEUE_ALLOWANCE_MS + FINALIZATION_ALLOWANCE_MS;

const PINNED_LAUNCHER = {
  name: "typed_fable_launcher.py",
  byte_length: 89395,
  sha256: "1721142dc01211a81a6014bbf52a8333b0ef635ae47fe751edd20c10b3a9bc94"
} as const;
const PINNED_ROUTER = {
  name: "claude_review_router.py",
  byte_length: 427362,
  sha256: "37c497ca87459268d49c9f90084e3df34acea3feb897305bfa7aec98740a6882"
} as const;

type PreparedState = {
  request_path: string;
  installed_root: string;
};

export class InstalledTypedFableLauncher implements FableLauncherPort {
  async readHistorical(input: HistoricalFableReadbackInput) {
    return readHistoricalFableReceipt(input, {
      installed_root: installedRootPath(),
      transport_root: transportRootPath()
    });
  }

  async preflight(): Promise<FableLauncherPreflight> {
    const installedRoot = installedRootPath();
    const launcherPath = join(installedRoot, PINNED_LAUNCHER.name);
    const routerPath = join(installedRoot, PINNED_ROUTER.name);
    await Promise.all([
      assertPinnedExecutable(launcherPath, PINNED_LAUNCHER),
      assertPinnedExecutable(routerPath, PINNED_ROUTER),
      ...FABLE_STATIC_DEPENDENCY_PINS.map(pin => assertPinnedStaticFile(join(installedRoot, pin.name), pin))
    ]);
    const described = await runProcessWithTail({
      executable: launcherPath,
      args: ["describe"],
      cwd: installedRoot,
      env: launcherEnvironment(),
      timeout_ms: 10_000,
      tail_bytes: 64 * 1024,
      capture_bytes: 256 * 1024
    });
    if (
      described.exit_code !== 0
      || described.timed_out
      || described.signal !== undefined
      || described.captured_output === undefined
      || described.captured_output.truncated
    ) {
      throw new Error("STOP_MANAGED_LAUNCHER_DESCRIBE_FAILED");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(described.captured_output.stdout);
    } catch {
      throw new Error("STOP_MANAGED_LAUNCHER_DESCRIBE_INVALID");
    }
    validateDescribe(payload);
    return {
      launcher_sha256: PINNED_LAUNCHER.sha256,
      router_sha256: PINNED_ROUTER.sha256,
      request_schema: REQUEST_SCHEMA,
      provider_contact_limit: 1,
      model_class: "FABLE",
      reasoning: "MAX"
    };
  }

  async prepare(input: {
    bundle_id: string;
    request: Record<string, unknown>;
    packet: Buffer;
  }): Promise<PreparedFableInvocation> {
    if (!/^[a-f0-9]{32}$/.test(input.bundle_id)) {
      throw new Error("STOP_MANAGED_BUNDLE_ID_INVALID");
    }
    const installedRoot = installedRootPath();
    const transportRoot = transportRootPath();
    await ensurePrivateDirectory(transportRoot);
    const bundlePath = join(transportRoot, input.bundle_id);
    try {
      await mkdir(bundlePath, { mode: OWNER_DIRECTORY_MODE });
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new Error("STOP_MANAGED_BUNDLE_ALREADY_EXISTS");
      throw error;
    }
    await assertPrivateDirectory(bundlePath);
    const requestBytes = canonicalFableLauncherRequestBytes(input.request);
    const requestSha256 = sha256Hex(requestBytes);
    const packetSha256 = sha256Hex(input.packet);
    const packetPath = join(bundlePath, "packet.txt");
    const requestPath = join(bundlePath, "request.json");
    await writeExclusiveReadBack(packetPath, input.packet);
    await writeExclusiveReadBack(requestPath, requestBytes);
    await fsyncDirectory(bundlePath);
    return {
      bundle_id: input.bundle_id,
      request_sha256: requestSha256,
      packet_sha256: packetSha256,
      opaque_state: {
        request_path: requestPath,
        installed_root: installedRoot
      } satisfies PreparedState
    };
  }

  async invoke(prepared: PreparedFableInvocation, onReceived?: FablePayloadObserver): Promise<FableLauncherInvocation> {
    const state = preparedState(prepared.opaque_state);
    const launcherPath = join(state.installed_root, PINNED_LAUNCHER.name);
    const result = await runProcessWithTail({
      executable: launcherPath,
      args: ["invoke", state.request_path, prepared.request_sha256],
      cwd: state.installed_root,
      env: launcherEnvironment(),
      timeout_ms: LAUNCH_TIMEOUT_MS,
      tail_bytes: 128 * 1024,
      capture_bytes: MAX_LAUNCHER_OUTPUT_BYTES,
      stderr_capture_bytes: MAX_LAUNCHER_STDERR_BYTES
    });
    const capture = result.captured_output;
    const execution = {
      ...(result.exit_code === undefined ? {} : { exit_code: result.exit_code }),
      timed_out: result.timed_out,
      ...(result.signal === undefined ? {} : { signal: result.signal })
    };
    // A failed process may already have emitted a complete review candidate.
    // Never parse a truncated prefix, even when that prefix is valid JSON.
    if (!capture || (capture.stdout_truncated ?? capture.truncated)
      || capture.stdout_utf8_valid === false) {
      return { ...execution, output_complete: false };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(capture.stdout);
    } catch {
      return { ...execution, output_complete: false };
    }
    const invocation: FableLauncherInvocation = {
      ...execution,
      output_complete: result.exit_code === 0 && !result.timed_out
        && result.signal === undefined && !capture.truncated,
      payload
    };
    // Persist the sanitized candidate before receipt validation can reject it.
    // Keep the payload and known contact if local persistence fails.
    try {
      await onReceived?.(payload);
    } catch {
      invocation.retention_failed = true;
      return invocation;
    }
    // Retention is not adoption. Failed execution or incomplete diagnostics
    // stays fail-closed, without receipt adoption or another invocation.
    if (!invocation.output_complete) return invocation;
    const attemptId = successAttemptId(payload);
    if (attemptId !== undefined) {
      invocation.receipt_readback = await readSuccessReceipt(state.installed_root, attemptId, payload);
    }
    return invocation;
  }
}

function validateDescribe(value: unknown): void {
  const record = asRecord(value);
  const supportedSchemas = record.supported_request_schemas;
  const carrierValues = record.output_carriers;
  const maxValue = record.provider_contacts_per_launcher_invocation_max;
  const successorValue = record.automatic_successor_per_launcher_invocation;
  const maxForV2 = typeof maxValue === "number" ? maxValue : asRecord(maxValue)[REQUEST_SCHEMA];
  const successorForV2 = asRecord(successorValue)[REQUEST_SCHEMA];
  if (
    !Array.isArray(supportedSchemas)
    || !supportedSchemas.includes(REQUEST_SCHEMA)
    || record.automatic_fallback !== "DISABLED"
    || record.automatic_retry !== "DISABLED"
    || record.credential_mutation !== "PROHIBITED"
    || record.provider_contacts_per_attempt !== 1
    || record.provider_contacts_per_router_attempt !== 1
    || maxForV2 !== 1
    || successorForV2 !== "DISABLED"
    || record.packet_output_contract_preflight !== "CANONICAL_SCHEMA_REQUIRED_WHEN_EXPLICIT"
    || record.default_output_carrier !== "TEXT_JSON"
    || !Array.isArray(carrierValues)
    || !carrierValues.includes("TEXT_JSON")
    || record.required_capability_class !== "FABLE"
    || record.required_reasoning !== "MAX"
    || record.valid_semantic_results_per_review_epoch !== 1
  ) {
    throw new Error("STOP_MANAGED_LAUNCHER_CONTRACT_MISMATCH");
  }
}

async function readSuccessReceipt(
  installedRoot: string,
  attemptId: string,
  payload: unknown
): Promise<FableReceiptReadback> {
  try {
    const publicPayload = asRecord(payload);
    const locator = publicPayload.sanitized_diagnostic_path;
    if (typeof locator !== "string") throw new Error("receipt locator missing");
    const parts = locator.split("/");
    if (
      parts.length !== 6
      || parts[0] !== "runtime"
      || !["claude_lain1", "claude_lain2"].includes(parts[1] ?? "")
      || parts[2] !== "diagnostics"
      || parts[3] !== "invocations"
      || parts[4] !== attemptId
      || parts[5] !== "receipt.json"
      || locator !== parts.join("/")
    ) {
      throw new Error("receipt locator invalid");
    }
    const bytes = await readNativePrivateFile(installedRoot, locator, MAX_RECEIPT_BYTES);
    const receiptSha256 = sha256Hex(bytes);
    const receipt = asRecord(JSON.parse(bytes.toString("ascii")));
    const publicBinding = asRecord(publicPayload.response_binding);
    const publicRecord = asRecord(publicPayload.review_record);
    const attestation = asRecord(publicPayload.attestation);
    const record = asRecord(receipt.review_record);
    const responseSha256 = receipt.RESPONSE_SHA256;
    const responseBytes = receipt.RESPONSE_UTF8_BYTES;
    if (
      receipt.RECEIPT_SCHEMA !== "claude-review-router-attempt-receipt.v3"
      || record.schema !== "claude-review-router-review-record.v2"
      || receipt.INVOCATION_ID !== attemptId
      || receipt.SANITIZED_DIAGNOSTIC_PATH !== locator
      || receipt.PROVIDER_CONTACT !== "YES"
      || receipt.EFFECT_DISPOSITION !== "VALID_REVIEW_RESULT"
      || receipt.OUTCOME_CLASS !== "SUCCESS"
      || receipt.RESULT !== publicPayload.result
      || receipt.TERMINAL_TITLE_SUPPRESSION !== "ACTIVE"
      || receipt.AUTOMATIC_FALLBACK !== "DISABLED"
      // Retry controls are public attestation fields, not receipt v3 fields.
      || attestation.provider_retry !== "DISABLED"
      || attestation.provider_retry_limit !== 0
      || receipt.EXPLICIT_CONCURRENCY_LIMIT !== 1
      || record.attempt_id !== attemptId
      || record.provider_contact_state !== "YES"
      || record.effect_disposition !== "VALID_REVIEW_RESULT"
      || record.valid_semantic_review_state !== "YES"
      || record.requested_model_class_attestation !== "FABLE"
      || record.observed_model_class_attestation !== "FABLE"
      || record.requested_reasoning_attestation !== "MAX"
      || record.observed_reasoning_attestation !== "MAX"
      || canonicalJson(record) !== canonicalJson(publicRecord)
      || typeof responseSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(responseSha256)
      || typeof responseBytes !== "number"
      || !Number.isSafeInteger(responseBytes)
      || responseBytes <= 0
      || responseBytes > 1024 * 1024
      || publicBinding.sha256 !== responseSha256
      || publicBinding.utf8_bytes !== responseBytes
      // Public retention labels are not proof. Read native body and binding below.
      || typeof publicPayload.response !== "string"
      || Buffer.byteLength(publicPayload.response, "utf8") !== responseBytes
      || sha256Hex(publicPayload.response) !== responseSha256
    ) {
      throw new Error("receipt mismatch");
    }
    await verifyNativeFableRetention({ installed_root: installedRoot, receipt,
      receipt_bytes: bytes, response: publicPayload.response as string });
    return {
      ok: true,
      attempt_id: attemptId,
      receipt_sha256: receiptSha256,
      response_sha256: responseSha256,
      response_utf8_bytes: responseBytes
    };
  } catch {
    return { ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED" };
  }
}

function successAttemptId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (
    !["PASS", "REVISE", "BLOCK"].includes(String(record.result))
    || typeof record.invocation_id !== "string"
    || !/^[a-f0-9]{32}$/.test(record.invocation_id)
    || record.model_class !== "FABLE"
    || record.reasoning !== "MAX"
  ) {
    return undefined;
  }
  return record.invocation_id;
}

function preparedState(value: unknown): PreparedState {
  const record = asRecord(value);
  if (typeof record.request_path !== "string" || typeof record.installed_root !== "string") {
    throw new Error("STOP_MANAGED_PREPARED_STATE_INVALID");
  }
  return { request_path: record.request_path, installed_root: record.installed_root };
}

function launcherEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: homedir(),
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1"
  };
}

function installedRootPath(): string {
  return join(homedir(), ...INSTALLED_ROOT_PARTS);
}

function transportRootPath(): string {
  return join("/", ...TRANSPORT_ROOT_PARTS);
}

async function assertPinnedExecutable(
  path: string,
  expected: { byte_length: number; sha256: string }
): Promise<void> {
  await assertPinnedStaticFile(path, { ...expected, mode: 0o700 });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await assertPrivateDirectory(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: OWNER_DIRECTORY_MODE });
    await assertPrivateDirectory(path);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentUid()
    || (metadata.mode & 0o777) !== OWNER_DIRECTORY_MODE
  ) {
    throw new Error("STOP_MANAGED_OWNER_DIRECTORY_INVALID");
  }
}

async function writeExclusiveReadBack(path: string, bytes: Buffer): Promise<void> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, OWNER_FILE_MODE);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== currentUid()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE
    ) {
      throw new Error("STOP_MANAGED_TRANSPORT_FILE_INVALID");
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readBack = await readPrivateRegularFile(path, bytes.length);
  if (!readBack.equals(bytes)) throw new Error("STOP_MANAGED_TRANSPORT_READBACK_MISMATCH");
}

async function readPrivateRegularFile(path: string, maximum: number): Promise<Buffer> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== currentUid()
      || (metadata.mode & 0o077) !== 0
      || metadata.size > maximum
    ) {
      throw new Error("STOP_MANAGED_OWNER_FILE_INVALID");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP") && !hasCode(error, "EISDIR")) throw error;
  } finally {
    await handle.close();
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("STOP_MANAGED_OWNER_ID_UNAVAILABLE");
  return uid;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
