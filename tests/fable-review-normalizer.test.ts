import { describe, expect, test } from "vitest";
import type { FableLauncherInvocation } from "../src/services/fable-launcher-port.js";
import {
  normalizeFableInvocation,
  unknownFableOutcome
} from "../src/services/fable-review-normalizer.js";
import type { FableReviewPreparation } from "../src/services/fable-review-packet.js";
import { sha256Hex } from "../src/task-runtime/canonical-json.js";

const HEAD = "1".repeat(40);
const TREE = "2".repeat(40);
const BASE = "3".repeat(40);
const BASE_TREE = "4".repeat(40);
const SCOPE = "5".repeat(64);
const PACKET_BYTES = Buffer.from("REVIEW_PACKET_V1\n" + JSON.stringify({
  schema: "chat-pro-repository-fable-review-header.v1",
  target: { head_sha: HEAD, tree_sha: TREE, scope_sha256: SCOPE }
}) + "\nsynthetic packet");
const PACKET = sha256Hex(PACKET_BYTES);
const RESPONSE = "7".repeat(64);
const RECEIPT = "8".repeat(64);
const ATTEMPT = "9".repeat(32);

const preparation: FableReviewPreparation = {
  target: {
    base_commit_sha: BASE,
    base_tree_sha: BASE_TREE,
    head_sha: HEAD,
    tree_sha: TREE
  },
  scope: {
    kind: "all_changes",
    paths: [],
    sha256: SCOPE
  },
  lineage: {
    lineage_id: `fable_lineage_${"a".repeat(32)}`,
    epoch_id: `fable_epoch_${"b".repeat(32)}`,
    kind: "initial"
  },
  packet: {
    sha256: PACKET,
    body_sha256: PACKET,
    byte_length: PACKET_BYTES.length
  },
  packet_bytes: PACKET_BYTES,
  request: {},
  bundle_id: "c".repeat(32),
  admission_key: "initial:fixture"
};

function validReviewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    result: "PASS",
    invocation_id: ATTEMPT,
    sanitized_diagnostic_path: `runtime/claude_lain2/diagnostics/invocations/${ATTEMPT}/receipt.json`,
    route: "private-route-value",
    response: "private retained provider response",
    resolved_models: ["private-provider-model"],
    model_class: "FABLE",
    reasoning: "MAX",
    terminal_title_suppression: "ACTIVE",
    automatic_fallback: "DISABLED",
    refusal_fallback: "DISABLED",
    explicit_concurrency_limit: 1,
    review_result: {
      schema: "claude-review-router-findings.v1",
      review_status: "PASS",
      summary: "No material findings.",
      findings: []
    },
    response_binding: {
      sha256: RESPONSE,
      utf8_bytes: 120
    },
    review_record: {
      attempt_id: ATTEMPT,
      schema: "claude-review-router-review-record.v2",
      provider_contact_state: "YES",
      valid_semantic_review_state: "YES",
      effect_disposition: "VALID_REVIEW_RESULT",
      requested_model_class_attestation: "FABLE",
      observed_model_class_attestation: "FABLE",
      requested_reasoning_attestation: "MAX",
      observed_reasoning_attestation: "MAX",
      focused_rereview_state: "INITIAL",
      exact_target_bindings: {
        commit: HEAD,
        tree: TREE,
        digest: `sha256:${PACKET}`,
        target_scope_sha256: SCOPE
      }
    },
    attestation: {
      capability_class: "FABLE",
      reasoning: "MAX",
      terminal_title_suppression: "ACTIVE",
      tools: "DISABLED",
      mcp: "DISABLED",
      session_persistence: false,
      automatic_fallback: "DISABLED",
      refusal_fallback: "DISABLED",
      provider_retry: "DISABLED",
      provider_retry_limit: 0
    },
    response_retention: {
      availability: "AVAILABLE",
      private_path: "/must/not/escape"
    },
    ...overrides
  };
}

function validInvocation(overrides: Partial<FableLauncherInvocation> = {}): FableLauncherInvocation {
  return {
    exit_code: 0,
    timed_out: false,
    output_complete: true,
    payload: validReviewPayload(),
    receipt_readback: {
      ok: true,
      attempt_id: ATTEMPT,
      receipt_sha256: RECEIPT,
      response_sha256: RESPONSE,
      response_utf8_bytes: 120
    },
    ...overrides
  };
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? field as Record<string, unknown>
    : {};
}

describe("managed Fable review output normalization", () => {
  test("accepts exactly one retained FABLE/MAX result and emits no private launcher fields", () => {
    const result = normalizeFableInvocation(validInvocation(), preparation, "initial");
    expect(result).toEqual({
      review_state: "review_completed",
      provider_contact: "YES",
      effect_disposition: "VALID_REVIEW_RESULT",
      outcome_code: "PASS",
      receipt: {
        attempt_id: ATTEMPT,
        receipt_sha256: RECEIPT,
        response_sha256: RESPONSE,
        response_utf8_bytes: 120,
        retained_read_back: true
      },
      review_result: {
        schema: "claude-review-router-findings.v1",
        review_status: "PASS",
        summary: "No material findings.",
        findings: []
      }
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("private retained provider response");
    expect(encoded).not.toContain("private-provider-model");
    expect(encoded).not.toContain("private-route-value");
    expect(encoded).not.toContain("/must/not/escape");
  });

  test.each([undefined, null, { availability: "UNAVAILABLE" }])(
    "does not invent a router retention requirement for %j",
    retention => {
      const result = normalizeFableInvocation(validInvocation({
        payload: validReviewPayload({ response_retention: retention })
      }), preparation, "initial");
      expect(result).toMatchObject({
        review_state: "review_completed", provider_contact: "YES", outcome_code: "PASS"
      });
    }
  );

  test("preserves a known contacted incomplete review instead of relabeling it precontact", () => {
    const result = normalizeFableInvocation({
      exit_code: 1,
      timed_out: false,
      output_complete: true,
      payload: {
        result: "STOP_PROVIDER_RESPONSE_INCOMPLETE",
        provider_contact: "YES",
        effect_disposition: "PARTIAL_EXTERNAL_EFFECT",
        retry_authorized: "NO"
      }
    }, preparation, "initial");
    expect(result).toEqual({
      review_state: "contacted_incomplete",
      provider_contact: "YES",
      effect_disposition: "PARTIAL_EXTERNAL_EFFECT",
      outcome_code: "STOP_PROVIDER_RESPONSE_INCOMPLETE"
    });
  });

  test("turns retained-response read-back failure into contacted incomplete", () => {
    const result = normalizeFableInvocation(validInvocation({
      receipt_readback: {
        ok: false,
        code: "STOP_MANAGED_RECEIPT_READBACK_FAILED"
      }
    }), preparation, "initial");
    expect(result).toMatchObject({
      review_state: "contacted_incomplete",
      provider_contact: "YES",
      effect_disposition: "ATTEMPT_EFFECT_ONLY",
      outcome_code: "STOP_MANAGED_RECEIPT_READBACK_FAILED"
    });
  });

  test.each([
    ["model class", { model_class: "OTHER" }],
    ["reasoning", { reasoning: "LOW" }],
    ["fallback", { automatic_fallback: "ENABLED" }],
    ["retry", {
      attestation: {
        ...recordField(validReviewPayload(), "attestation"),
        provider_retry_limit: 1
      }
    }],
    ["target", {
      review_record: {
        ...recordField(validReviewPayload(), "review_record"),
        exact_target_bindings: {
          commit: "0".repeat(40),
          tree: TREE,
          digest: `sha256:${PACKET}`
        }
      }
    }]
  ] as Array<[string, Record<string, unknown>]>) ("fails closed after contact on %s attestation mismatch", (_label, override) => {
    const result = normalizeFableInvocation(validInvocation({
      payload: validReviewPayload(override)
    }), preparation, "initial");
    expect(result).toMatchObject({
      review_state: "contacted_incomplete",
      provider_contact: "YES",
      effect_disposition: "ATTEMPT_EFFECT_ONLY",
      outcome_code: "STOP_MANAGED_REVIEW_ATTESTATION_MISMATCH"
    });
  });

  test.each(["scope", "bytes"] as const)("rejects changed packet %s without losing contact", changed => {
    const altered: FableReviewPreparation = changed === "scope"
      ? { ...preparation, scope: { ...preparation.scope, sha256: "0".repeat(64) } }
      : { ...preparation, packet_bytes: Buffer.concat([PACKET_BYTES, Buffer.from("changed")]) };
    expect(normalizeFableInvocation(validInvocation(), altered, "initial"))
      .toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
  });

  test("requires the focused rereview attestation on a successor epoch", () => {
    const focused: FableReviewPreparation = {
      ...preparation,
      scope: { kind: "focused_paths", paths: ["src/fix.ts"], sha256: SCOPE },
      lineage: { ...preparation.lineage, kind: "focused_rereview" as const }
    };
    const initialPayload = validReviewPayload();
    const rejected = normalizeFableInvocation(validInvocation({ payload: initialPayload }), focused, "focused_rereview");
    expect(rejected.review_state).toBe("contacted_incomplete");
    const focusedPayload = validReviewPayload({
      review_record: {
        ...recordField(initialPayload, "review_record"),
        focused_rereview_state: "FOCUSED"
      }
    });
    expect(normalizeFableInvocation(validInvocation({ payload: focusedPayload }), focused, "focused_rereview"))
      .toMatchObject({ review_state: "review_completed", provider_contact: "YES" });
  });

  test("does not let contradictory top-level no-contact erase a contacted receipt", () => {
    const result = normalizeFableInvocation(validInvocation({
      payload: validReviewPayload({ provider_contact: "NO" }),
      receipt_readback: { ok: false, code: "STOP_MANAGED_RECEIPT_READBACK_FAILED" }
    }), preparation, "initial");
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
  });

  test("does not adopt a success payload with contradictory contact evidence", () => {
    expect(normalizeFableInvocation(validInvocation({
      payload: validReviewPayload({ provider_contact: "NO" })
    }), preparation, "initial"))
      .toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
  });

  test.each([false, true])("preserves known contact on incomplete or unknown local output: %s", complete => {
    const result = normalizeFableInvocation({
      output_complete: complete, timed_out: !complete,
      payload: { result: "STOP_LOCAL_FINALIZATION_UNKNOWN", provider_contact: "YES",
        effect_disposition: "UNKNOWN_EXTERNAL_EFFECT" }
    }, preparation, "initial");
    expect(result).toMatchObject({ review_state: "contacted_incomplete", provider_contact: "YES" });
    expect(result.review_result).toBeUndefined();
  });

  test("keeps truncated, unparseable, or thrown-contact effects unknown", () => {
    expect(normalizeFableInvocation({
      timed_out: true,
      output_complete: false
    }, preparation, "initial")).toEqual(unknownFableOutcome("STOP_MANAGED_LAUNCH_OUTPUT_UNKNOWN"));
  });
});
