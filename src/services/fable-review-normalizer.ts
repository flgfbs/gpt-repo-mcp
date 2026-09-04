import {
  FableReviewResultSchema,
  type FableReviewEvidence,
  type FableReviewResult,
  type RepoRunFableReviewInput
} from "../contracts/fable-review.contract.js";
import type { FableLauncherInvocation } from "./fable-launcher-port.js";
import type { FableReviewPreparation } from "./fable-review-packet.js";

export type NormalizedFableOutcome = Pick<FableReviewEvidence,
  "review_state" | "provider_contact" | "effect_disposition" | "outcome_code"
> & {
  receipt?: FableReviewEvidence["receipt"];
  review_result?: FableReviewResult;
};

export function normalizeFableInvocation(
  invocation: FableLauncherInvocation,
  preparation: FableReviewPreparation,
  reviewKind: RepoRunFableReviewInput["review_kind"]
): NormalizedFableOutcome {
  if (!invocation.output_complete || invocation.payload === undefined) {
    return unknownFableOutcome("STOP_MANAGED_LAUNCH_OUTPUT_UNKNOWN");
  }
  const payload = asRecord(invocation.payload);
  const contact = observedContact(payload);
  if (["PASS", "REVISE", "BLOCK"].includes(String(payload.result))) {
    let reviewResult: FableReviewResult | undefined;
    try {
      reviewResult = FableReviewResultSchema.parse(payload.review_result);
      const record = asRecord(payload.review_record);
      const binding = asRecord(payload.response_binding);
      const retention = asRecord(payload.response_retention);
      const attestation = asRecord(payload.attestation);
      const exactTarget = asRecord(record.exact_target_bindings);
      const receipt = invocation.receipt_readback;
      if (receipt?.ok !== true) {
        throw new Error("receipt read-back failed");
      }
      if (
        payload.result !== reviewResult.review_status
        || payload.model_class !== "FABLE"
        || payload.reasoning !== "MAX"
        || payload.terminal_title_suppression !== "ACTIVE"
        || payload.automatic_fallback !== "DISABLED"
        || payload.refusal_fallback !== "DISABLED"
        || payload.explicit_concurrency_limit !== 1
        || record.provider_contact_state !== "YES"
        || payload.invocation_id !== receipt.attempt_id
        || record.attempt_id !== receipt.attempt_id
        || record.valid_semantic_review_state !== "YES"
        || record.effect_disposition !== "VALID_REVIEW_RESULT"
        || record.requested_model_class_attestation !== "FABLE"
        || record.observed_model_class_attestation !== "FABLE"
        || record.requested_reasoning_attestation !== "MAX"
        || record.observed_reasoning_attestation !== "MAX"
        || record.focused_rereview_state !== (reviewKind === "focused_rereview" ? "FOCUSED" : "INITIAL")
        || exactTarget.commit !== preparation.target.head_sha
        || exactTarget.tree !== preparation.target.tree_sha
        || exactTarget.digest !== `sha256:${preparation.packet.body_sha256}`
        || exactTarget.target_scope_sha256 !== preparation.scope.sha256
        || attestation.capability_class !== "FABLE"
        || attestation.reasoning !== "MAX"
        || attestation.terminal_title_suppression !== "ACTIVE"
        || attestation.tools !== "DISABLED"
        || attestation.mcp !== "DISABLED"
        || attestation.session_persistence !== false
        || attestation.automatic_fallback !== "DISABLED"
        || attestation.refusal_fallback !== "DISABLED"
        || attestation.provider_retry !== "DISABLED"
        || attestation.provider_retry_limit !== 0
        || typeof binding.sha256 !== "string"
        || retention.availability !== "AVAILABLE"
        || !/^[a-f0-9]{64}$/.test(binding.sha256)
        || typeof binding.utf8_bytes !== "number"
        || !Number.isSafeInteger(binding.utf8_bytes)
        || receipt.response_sha256 !== binding.sha256
        || receipt.response_utf8_bytes !== binding.utf8_bytes
      ) {
        throw new Error("attestation mismatch");
      }
      return {
        review_state: "review_completed",
        provider_contact: "YES",
        effect_disposition: "VALID_REVIEW_RESULT",
        outcome_code: reviewResult.review_status,
        receipt: {
          attempt_id: receipt.attempt_id,
          receipt_sha256: receipt.receipt_sha256,
          response_sha256: receipt.response_sha256,
          response_utf8_bytes: receipt.response_utf8_bytes,
          retained_read_back: true
        },
        review_result: reviewResult
      };
    } catch {
      return contact === "YES"
        ? contactedFableOutcome(
          invocation.receipt_readback?.ok === false
            ? invocation.receipt_readback.code
            : "STOP_MANAGED_REVIEW_ATTESTATION_MISMATCH"
        )
        : contact === "NO"
          ? precontactFableOutcome("STOP_MANAGED_REVIEW_ATTESTATION_MISMATCH")
          : unknownFableOutcome("STOP_MANAGED_REVIEW_ATTESTATION_UNKNOWN");
    }
  }
  const code = safeFableOutcomeCode(payload.result);
  const effect = payload.effect_disposition;
  if (contact === "NO" && effect === "NO_EXTERNAL_EFFECT") {
    return precontactFableOutcome(code);
  }
  if (
    contact === "YES"
    && ["ATTEMPT_EFFECT_ONLY", "PARTIAL_EXTERNAL_EFFECT"].includes(String(effect))
    && payload.retry_authorized === "NO"
  ) {
    return {
      review_state: "contacted_incomplete",
      provider_contact: "YES",
      effect_disposition: effect as "ATTEMPT_EFFECT_ONLY" | "PARTIAL_EXTERNAL_EFFECT",
      outcome_code: code
    };
  }
  return unknownFableOutcome(
    code === "STOP_MANAGED_LAUNCH_FAILURE"
      ? "STOP_MANAGED_LAUNCH_EFFECT_UNKNOWN"
      : code
  );
}

export function precontactFableOutcome(code: string): NormalizedFableOutcome {
  return {
    review_state: "failed_precontact",
    provider_contact: "NO",
    effect_disposition: "NO_EXTERNAL_EFFECT",
    outcome_code: safeFableOutcomeCode(code)
  };
}

export function contactedFableOutcome(code: string): NormalizedFableOutcome {
  return {
    review_state: "contacted_incomplete",
    provider_contact: "YES",
    effect_disposition: "ATTEMPT_EFFECT_ONLY",
    outcome_code: safeFableOutcomeCode(code)
  };
}

export function unknownFableOutcome(code: string): NormalizedFableOutcome {
  return {
    review_state: "unknown_effect",
    provider_contact: "UNKNOWN",
    effect_disposition: "UNKNOWN_EXTERNAL_EFFECT",
    outcome_code: safeFableOutcomeCode(code)
  };
}

export function safeFableOutcomeCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z0-9][A-Z0-9._:-]{0,159}$/.test(value)
    ? value
    : "STOP_MANAGED_LAUNCH_FAILURE";
}

function observedContact(payload: Record<string, unknown>): "NO" | "YES" | "UNKNOWN" {
  if (payload.provider_contact === "NO" || payload.provider_contact === "YES") return payload.provider_contact;
  const record = asRecord(payload.review_record);
  if (record.provider_contact_state === "NO" || record.provider_contact_state === "YES") {
    return record.provider_contact_state;
  }
  return "UNKNOWN";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
