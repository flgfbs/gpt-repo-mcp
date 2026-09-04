import { canonicalJson } from "../task-runtime/canonical-json.js";

export type FableLauncherPreflight = {
  launcher_sha256: string;
  router_sha256: string;
  request_schema: "claude-review-router-typed-launch.v2";
  provider_contact_limit: 1;
  model_class: "FABLE";
  reasoning: "MAX";
};

export type PreparedFableInvocation = {
  bundle_id: string;
  request_sha256: string;
  packet_sha256: string;
  opaque_state: unknown;
};

export type FableReceiptReadback = {
  ok: true;
  attempt_id: string;
  receipt_sha256: string;
  response_sha256: string;
  response_utf8_bytes: number;
} | {
  ok: false;
  code: "STOP_MANAGED_RECEIPT_READBACK_FAILED";
};

export type FableLauncherInvocation = {
  exit_code?: number;
  timed_out: boolean;
  signal?: string;
  output_complete: boolean;
  payload?: unknown;
  receipt_readback?: FableReceiptReadback;
};

export function canonicalFableLauncherRequestBytes(value: Record<string, unknown>): Buffer {
  const encoded = `${canonicalJson(value)}\n`;
  if (!/^[\x00-\x7F]*$/.test(encoded)) {
    throw new Error("STOP_MANAGED_REQUEST_NONASCII");
  }
  return Buffer.from(encoded, "ascii");
}

export interface FableLauncherPort {
  preflight(): Promise<FableLauncherPreflight>;
  prepare(input: {
    bundle_id: string;
    request: Record<string, unknown>;
    packet: Buffer;
  }): Promise<PreparedFableInvocation>;
  invoke(prepared: PreparedFableInvocation): Promise<FableLauncherInvocation>;
}
