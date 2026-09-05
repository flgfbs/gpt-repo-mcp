import {
  FableReviewEvidenceSchema,
  FableRecoveryEvidenceSchema,
  type FableRecoveryEvidence,
  RepoRunFableReviewInputSchema,
  RepoRunFableReviewResultSchema,
  type FableReviewEvidence,
  type RepoRunFableReviewInput,
  type RepoRunFableReviewResult
} from "../contracts/fable-review.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { canonicalJson, canonicalSha256, hashedDiskKey, sha256Hex } from "../task-runtime/canonical-json.js";
import type { TaskArtifactMetadata, TaskArtifactStore } from "../task-runtime/artifact-store.js";
import { hasCode } from "../task-runtime/secure-runtime-fs.js";
import type { ExactTaskMutationState, TaskRuntimeService } from "../task-runtime/task-service.js";
import { FableReviewClaimStore } from "./fable-review-claim-store.js";
import { FableReceivedStore, receivedReviewMatches, type ReceivedFableReview } from "./fable-received-store.js";
import type { FableLauncherInvocation, FableLauncherPort } from "./fable-launcher-port.js";
import { canonicalFableLauncherRequestBytes } from "./fable-launcher-port.js";
import {
  normalizeFableInvocation,
  observedFableContact,
  precontactFableOutcome,
  safeFableOutcomeCode,
  contactedFableOutcome,
  unknownFableOutcome,
  type NormalizedFableOutcome
} from "./fable-review-normalizer.js";
import {
  advanceFableReviewOperation,
  createFableReviewOperation,
  isTerminalFableOperation,
  terminalizeFableReviewOperation
} from "./fable-review-operation.js";
import {
  assertExactFableTaskBinding,
  buildFableReviewPreparation,
  canonicalFableScope,
  exactFableGitState,
  targetFromInput,
  validateFablePreflight,
  type CanonicalFableScope,
  type ExactFableTarget,
  type FableReviewPreparation,
  type PriorFableReview
} from "./fable-review-packet.js";
import type { RootRegistry } from "./root-registry.js";
import { SecretScanner } from "./secret-scanner.js";

const ARTIFACT_WINDOW_BYTES = 64 * 1024;
const MAX_PRIOR_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface ManagedFableReviewRuntime {
  run(input: RepoRunFableReviewInput): Promise<RepoRunFableReviewResult>;
}

type ServiceOptions = {
  now?: () => Date;
};

export class ManagedFableReviewService implements ManagedFableReviewRuntime {
  private readonly now: () => Date;
  private readonly scanner = new SecretScanner();
  private readonly claims: FableReviewClaimStore;
  private readonly received: FableReceivedStore;

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    private readonly artifacts: TaskArtifactStore,
    private readonly launcher: FableLauncherPort,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.claims = new FableReviewClaimStore(tasks.fs);
    this.received = new FableReceivedStore(tasks.fs);
  }

  async run(rawInput: RepoRunFableReviewInput): Promise<RepoRunFableReviewResult> {
    const input = RepoRunFableReviewInputSchema.parse(rawInput);
    const target = targetFromInput(input);
    const scope = canonicalFableScope(input, target);
    const binding = this.registry.taskBinding(input.repo_id);
    if (!binding || binding.task_repo_id !== input.repo_id || binding.task_id !== input.task_id) {
      return resultEnvelope(failedEvidence(input, target, scope, "TASK_REPO_REQUIRED", this.now()), []);
    }
    if (binding.authority !== "implement" && binding.authority !== "ship") {
      return resultEnvelope(failedEvidence(input, target, scope, "TASK_AUTHORITY_REJECTED", this.now()), []);
    }
    const existing = await this.tasks.states.readOperation(input.task_id, input.operation_id);
    if (existing) throw duplicateOperation(existing.operation_id, existing.phase);

    let evidence: FableReviewEvidence;
    let capturedEvidence: FableReviewEvidence | undefined;
    let stateChangedAfter = false;
    try {
      const locked = await this.tasks.runWithExactTaskState({
        task_id: input.task_id,
        expected_head: input.expected_head_sha,
        expected_tree: input.expected_tree_sha
      }, async (before) => {
        capturedEvidence = await this.runLocked(input, scope, target, before);
        return capturedEvidence;
      });
      evidence = locked.result;
      stateChangedAfter = (
        locked.after.head !== locked.before.head
        || locked.after.tree !== locked.before.tree
        || !locked.after.clean
      );
    } catch (error) {
      if (isOperationConflict(error)) throw error;
      // Failure after the callback (including Git refresh or lock release) is
      // not evidence that the already-entered contact boundary was untouched.
      if (capturedEvidence) {
        evidence = evidenceFailure(capturedEvidence, "STOP_MANAGED_POSTCONTACT_STATE_READBACK_FAILED");
      } else {
        const observed = await this.tasks.states.readOperation(input.task_id, input.operation_id).catch(() => null);
        const uncontacted = observed === undefined || (observed !== null
          && ["CREATED", "ADMITTED", "FAILED_PRECONTACT"].includes(observed.phase));
        const knownContact = observed !== null && observed !== undefined
          && ["EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED", "FAILED_KNOWN_AFTER_CONTACT"].includes(observed.phase);
        evidence = evidenceRecord(input, target, scope, undefined,
          uncontacted ? precontactFableOutcome(safeErrorCode(error))
            : knownContact ? contactedFableOutcome("STOP_MANAGED_STATE_READBACK_FAILED")
              : unknownFableOutcome("STOP_MANAGED_STATE_READBACK_UNKNOWN"), this.now());
      }
    }

    const warnings = stateChangedAfter ? ["TASK_STATE_CHANGED_AFTER_REVIEW_OPERATION"] : [];
    if (stateChangedAfter) evidence = evidenceFailure(evidence, "STOP_MANAGED_TARGET_DRIFT_AFTER_INVOCATION");
    let artifact: TaskArtifactMetadata | undefined;
    const publishBytes = canonicalJson(evidence);
    try {
      artifact = await this.publishEvidence(evidence);
      const readBack = await readWholeArtifact(this.artifacts, input.task_id, artifact.artifact_id);
      if (readBack !== publishBytes) throw new Error("STOP_MANAGED_ARTIFACT_READBACK_FAILED");
    } catch {
      artifact = undefined;
      warnings.push("FABLE_REVIEW_EVIDENCE_ARTIFACT_WRITE_FAILED");
      evidence = evidenceFailure(evidence, "STOP_MANAGED_ARTIFACT_RETENTION_FAILED");
    }
    try {
      evidence = await this.settleEvidence(input, evidence);
    } catch {
      warnings.push("FABLE_REVIEW_OPERATION_SETTLEMENT_FAILED");
      evidence = evidenceFailure(evidence, "STOP_MANAGED_OPERATION_SETTLEMENT_FAILED");
    }
    // Never return an artifact as the adopted result if settlement changed it.
    if (canonicalJson(evidence) !== publishBytes) artifact = undefined;
    return resultEnvelope(evidence, warnings, artifact);
  }

  private async runLocked(
    input: RepoRunFableReviewInput,
    scope: CanonicalFableScope,
    target: ExactFableTarget,
    before: ExactTaskMutationState
  ): Promise<FableReviewEvidence> {
    const duplicate = await this.tasks.states.readOperation(input.task_id, input.operation_id);
    if (duplicate) throw duplicateOperation(duplicate.operation_id, duplicate.phase);
    let operation = await createFableReviewOperation(this.tasks, input, this.now());
    let preparation: FableReviewPreparation | undefined;
    let claimWritten = false;
    let contactBoundaryEntered = false;
    let knownOutcome: NormalizedFableOutcome | undefined;
    try {
      assertExactFableTaskBinding(input, before);
      if (!before.clean) throw new Error("GIT_WORKTREE_DIRTY");
      operation = await advanceFableReviewOperation(
        this.tasks,
        operation,
        "ADMITTED",
        "NOT_STARTED",
        this.now()
      );
      const repo = this.registry.get(input.repo_id);
      const prior = input.review_kind === "focused_rereview"
        ? await this.readPriorReview(input, target)
        : undefined;
      const recovery = input.review_kind === "missing_body_recovery"
        ? await this.readMissingBodyRecovery(input, target) : undefined;
      preparation = await buildFableReviewPreparation({
        request: input,
        root: repo.root,
        target,
        scope,
        ...(prior ? { prior } : {}),
        ...(recovery ? { recovery } : {}),
        scanner: this.scanner
      });
      const preflight = await this.launcher.preflight();
      validateFablePreflight(preflight);
      await this.claims.assertAdmissible(input.task_id, preparation.admission_key);
      await this.received.assertFresh(input);
      const prepared = await this.launcher.prepare({
        bundle_id: preparation.bundle_id,
        request: preparation.request,
        packet: preparation.packet_bytes
      });
      const expectedRequestSha256 = hashedRequest(preparation.request);
      if (
        prepared.bundle_id !== preparation.bundle_id
        || prepared.packet_sha256 !== preparation.packet.sha256
        || prepared.request_sha256 !== expectedRequestSha256
      ) {
        throw new Error("STOP_MANAGED_TRANSPORT_BINDING_MISMATCH");
      }
      if (recovery) {
        const refreshed = await this.readMissingBodyRecovery(input, target);
        if (canonicalJson(refreshed) !== canonicalJson(recovery)) {
          throw new Error("STOP_MANAGED_RECOVERY_HISTORY_CHANGED");
        }
        const unsigned = {
          schema: "chat-pro-repository-recovery-preparation.v1",
          repo_id: input.repo_id, task_id: input.task_id, operation_id: input.operation_id,
          target, scope, lineage: preparation.lineage, packet: preparation.packet, recovery
        };
        const bytes = Buffer.from(canonicalJson({ ...unsigned, record_sha256: canonicalSha256(unsigned) }), "utf8");
        const path = `fable-recoveries/${hashedDiskKey("fable-recovery-task", input.task_id)}/${hashedDiskKey("fable-recovery-operation", input.operation_id)}.json`;
        await this.tasks.fs.atomicWrite(path, bytes, { exclusive: true });
        if (!(await this.tasks.fs.readFile(path, bytes.length)).equals(bytes)) {
          throw new Error("STOP_MANAGED_RECOVERY_RECORD_READBACK_FAILED");
        }
      }
      await this.claims.writeClaim({
        task_id: input.task_id,
        admission_key: preparation.admission_key,
        operation_id: input.operation_id,
        epoch_id: preparation.lineage.epoch_id,
        packet_sha256: preparation.packet.sha256,
        target,
        launcher_sha256: preflight.launcher_sha256,
        router_sha256: preflight.router_sha256,
        recorded_at: this.now().toISOString()
      });
      claimWritten = true;
      operation = await advanceFableReviewOperation(
        this.tasks,
        operation,
        "EXTERNAL_PRECONTACT",
        "NOT_STARTED",
        this.now()
      );

      let invocation: FableLauncherInvocation;
      let received: ReceivedFableReview | undefined;
      let receivedOnce = false;
      let receivedContact = false;
      let retentionError: string | undefined;
      const retain = async (payload: unknown): Promise<void> => {
        receivedContact ||= observedFableContact(payload) === "YES";
        if (receivedOnce) throw new Error("STOP_MANAGED_RECEIVED_CALLBACK_REPLAY");
        receivedOnce = true;
        try {
          received = await this.received.retain(input, preparation!, payload);
        } catch (error) {
          retentionError = safeErrorCode(error);
        }
      };
      contactBoundaryEntered = true;
      try {
        invocation = await this.launcher.invoke(prepared, retain);
        // Alternate typed adapters may deliver their received payload on return.
        // This is local persistence only, never a second launcher invocation.
        if (!receivedOnce && invocation.payload !== undefined) await retain(invocation.payload);
      } catch {
        const failed = receivedContact
          ? contactedFableOutcome("STOP_MANAGED_INVOKE_FAILED_AFTER_RECEIVED_CONTACT")
          : unknownFableOutcome("STOP_MANAGED_INVOKE_EFFECT_UNKNOWN");
        knownOutcome = failed;
        // Publish and settle through the same durable path as returned output.
        // A later local exception must not erase contact already observed.
        return evidenceRecord(input, target, scope, preparation, failed, this.now());
      }

      let outcome = normalizeFableInvocation(invocation, preparation, input.review_kind);
      if (retentionError || invocation.retention_failed
        || (outcome.review_state === "review_completed" && !receivedReviewMatches(received, outcome))) {
        const code = retentionError === "STOP_MANAGED_REVIEW_OUTPUT_BLOCKED"
          ? retentionError : "STOP_MANAGED_RECEIVED_RETENTION_FAILED";
        outcome = outcome.provider_contact === "YES" ? contactedFableOutcome(code)
          : outcome.provider_contact === "NO" ? precontactFableOutcome(code) : unknownFableOutcome(code);
      }
      if (
        outcome.review_result
        && this.scanner.hasSecretValue(canonicalJson(outcome.review_result))
      ) {
        outcome = contactedFableOutcome("STOP_MANAGED_REVIEW_OUTPUT_BLOCKED");
      }
      knownOutcome = outcome;
      const stable = await exactFableGitState(repo.root, target.head_sha, target.tree_sha);
      if (!stable) {
        outcome = outcome.provider_contact === "NO"
          ? precontactFableOutcome("STOP_MANAGED_TARGET_DRIFT")
          : outcome.provider_contact === "YES"
            ? contactedFableOutcome("STOP_MANAGED_TARGET_DRIFT_AFTER_CONTACT")
            : unknownFableOutcome("STOP_MANAGED_TARGET_DRIFT_EFFECT_UNKNOWN");
        knownOutcome = outcome;
      }
      // Final adoption waits until the task artifact has been written and read
      // back outside this non-reentrant task lock. The claim stays no-replay.
      knownOutcome = outcome;
      return evidenceRecord(input, target, scope, preparation, outcome, this.now());
    } catch (error) {
      const code = safeErrorCode(error);
      if (contactBoundaryEntered) {
        const outcome = knownOutcome ?? unknownFableOutcome("STOP_MANAGED_CONTACT_BOUNDARY_EFFECT_UNKNOWN");
        if (preparation) await this.writeClaimOutcomeBestEffort(input, preparation, outcome);
        if (!isTerminalFableOperation(operation)) {
          await terminalizeFableReviewOperation(
            this.tasks,
            operation,
            outcome,
            input.repo_id,
            this.now()
          ).catch(() => undefined);
        }
        return evidenceRecord(input, target, scope, preparation, outcome, this.now());
      }
      const outcome = precontactFableOutcome(code);
      if (claimWritten && preparation) await this.writeClaimOutcomeBestEffort(input, preparation, outcome);
      if (!isTerminalFableOperation(operation)) {
        await advanceFableReviewOperation(
          this.tasks,
          operation,
          "FAILED_PRECONTACT",
          "ABSENT",
          this.now(),
          code,
          input.repo_id
        ).catch(() => undefined);
      }
      return evidenceRecord(input, target, scope, preparation, outcome, this.now());
    }
  }

  private async settleEvidence(
    input: RepoRunFableReviewInput,
    initial: FableReviewEvidence
  ): Promise<FableReviewEvidence> {
    return this.tasks.locks.withLock(`task:${input.task_id}`, async () => {
      const operation = await this.tasks.states.readOperation(input.task_id, input.operation_id);
      if (!operation) {
        if (initial.review_state !== "failed_precontact") throw new Error("STOP_MANAGED_OPERATION_STATE_MISSING");
        return initial;
      }
      if (operation.kind !== "FABLE_REVIEW") throw new Error("STOP_MANAGED_OPERATION_BINDING_MISMATCH");
      if (isTerminalFableOperation(operation)) {
        if (initial.review_state === "review_completed") throw new Error("STOP_MANAGED_OPERATION_SETTLEMENT_CONFLICT");
        return initial;
      }
      let evidence = initial;
      if (evidence.review_state === "review_completed" && !await exactFableGitState(
        this.registry.get(input.repo_id).root, input.expected_head_sha, input.expected_tree_sha
      )) evidence = evidenceFailure(evidence, "STOP_MANAGED_TARGET_DRIFT_BEFORE_SETTLEMENT");
      if (evidence.lineage) {
        try {
          await this.claims.writeOutcome({
            task_id: input.task_id,
            admission_key: input.review_kind === "initial"
              ? `initial:${evidence.lineage.lineage_id}`
              : input.review_kind === "missing_body_recovery"
                ? `recovery:${input.missing_body_recovery!.prior_operation_id}`
                : `focused:${input.prior_review_artifact_id}`,
            operation_id: input.operation_id,
            epoch_id: evidence.lineage.epoch_id,
            provider_contact: evidence.provider_contact,
            effect_disposition: evidence.effect_disposition,
            outcome_code: evidence.outcome_code,
            recorded_at: this.now().toISOString()
          });
        } catch {
          evidence = evidenceFailure(evidence, "STOP_MANAGED_OUTCOME_READBACK_UNKNOWN");
        }
      }
      await terminalizeFableReviewOperation(this.tasks, operation, evidence, input.repo_id, this.now());
      return evidence;
    });
  }

  private async readMissingBodyRecovery(
    input: RepoRunFableReviewInput, target: ExactFableTarget
  ): Promise<FableRecoveryEvidence> {
    const locator = input.missing_body_recovery;
    if (!locator || !input.prior_review_artifact_id || !this.launcher.readHistorical) {
      throw new Error("STOP_MANAGED_RECOVERY_READBACK_UNAVAILABLE");
    }
    const content = await readWholeArtifact(this.artifacts, input.task_id, input.prior_review_artifact_id);
    const prior = FableReviewEvidenceSchema.parse(JSON.parse(content));
    const operation = await this.tasks.states.readOperation(input.task_id, locator.prior_operation_id);
    const expectedLineage = `fable_lineage_${canonicalSha256({
      schema: "chat-pro-repository-fable-lineage.v1",
      repo_id: input.repo_id, task_id: input.task_id,
      base_commit_sha: target.base_commit_sha, base_tree_sha: target.base_tree_sha
    }).slice(0, 32)}`;
    if (prior.repo_id !== input.repo_id || prior.task_id !== input.task_id
      || prior.operation_id !== locator.prior_operation_id
      || prior.schema !== "chat-pro-repository-managed-fable-review.v1"
      || prior.review_state !== "contacted_incomplete" || prior.provider_contact !== "YES"
      || prior.effect_disposition !== "ATTEMPT_EFFECT_ONLY"
      || prior.outcome_code !== "STOP_MANAGED_RECEIPT_READBACK_FAILED"
      || prior.review_result !== undefined || prior.receipt !== undefined
      || prior.lineage?.kind !== "initial" || prior.lineage.lineage_id !== expectedLineage
      || prior.lineage.prior_review_artifact_id !== undefined
      || !prior.packet || prior.scope.kind !== "all_changes" || prior.scope.paths.length !== 0
      || prior.scope.sha256 !== canonicalFableScope({ ...input, scope: { kind: "all_changes" } }, prior.target).sha256
      || operation?.kind !== "FABLE_REVIEW" || operation.phase !== "FAILED_KNOWN_AFTER_CONTACT"
      || operation.effect_state !== "PARTIAL" || operation.error_code !== prior.outcome_code
      || prior.target.base_commit_sha !== target.base_commit_sha
      || prior.target.base_tree_sha !== target.base_tree_sha
      || prior.target.head_sha === target.head_sha || prior.target.tree_sha === target.tree_sha) {
      throw new Error("STOP_MANAGED_RECOVERY_PRIOR_NOT_ELIGIBLE");
    }
    const oldRequest = {
      operation_id: prior.operation_id, repo_id: prior.repo_id, task_id: prior.task_id,
      expected_base_commit_sha: prior.target.base_commit_sha, expected_base_tree_sha: prior.target.base_tree_sha,
      expected_head_sha: prior.target.head_sha, expected_tree_sha: prior.target.tree_sha,
      review_kind: "initial", scope: { kind: "all_changes" }
    };
    const expectedEpoch = `fable_epoch_${canonicalSha256({
      schema: "chat-pro-repository-fable-epoch.v1", lineage_id: expectedLineage,
      operation_id: prior.operation_id, target: prior.target, scope_sha256: prior.scope.sha256,
      prior_review_artifact_id: "NONE"
    }).slice(0, 32)}`;
    if (operation.request_sha256 !== canonicalSha256(oldRequest) || prior.lineage.epoch_id !== expectedEpoch) {
      throw new Error("STOP_MANAGED_RECOVERY_OPERATION_BINDING_MISMATCH");
    }
    try {
      await this.received.read({ repo_id: input.repo_id, task_id: input.task_id, operation_id: prior.operation_id });
      throw new Error("STOP_MANAGED_RECOVERY_BODY_ALREADY_RETAINED");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const bound = await this.claims.readRecoveryPredecessor({
      task_id: input.task_id, operation_id: prior.operation_id,
      lineage_id: prior.lineage.lineage_id, epoch_id: prior.lineage.epoch_id,
      packet_sha256: prior.packet.sha256, target: prior.target
    });
    const bundleId = canonicalSha256({
      schema: "chat-pro-repository-fable-bundle.v1", task_id: input.task_id,
      operation_id: prior.operation_id, epoch_id: prior.lineage.epoch_id,
      packet_sha256: prior.packet.sha256
    }).slice(0, 32);
    const historical = await this.launcher.readHistorical({
      evidence: prior, attempt_id: locator.prior_attempt_id,
      expected_receipt_sha256: locator.expected_receipt_sha256, bundle_id: bundleId
    });
    if (historical.attempt_id !== locator.prior_attempt_id
      || historical.receipt_sha256 !== locator.expected_receipt_sha256) {
      throw new Error("STOP_MANAGED_RECOVERY_RECEIPT_DIGEST_MISMATCH");
    }
    return FableRecoveryEvidenceSchema.parse({
      schema: "chat-pro-repository-missing-body-recovery.v1",
      prior_operation_id: prior.operation_id, prior_operation_sha256: operation.state_sha256,
      prior_review_artifact_id: input.prior_review_artifact_id, prior_review_artifact_sha256: sha256Hex(content),
      prior_claim_sha256: bound.claim_sha256, prior_outcome_sha256: bound.outcome_sha256,
      prior_epoch_id: prior.lineage.epoch_id, prior_target: prior.target,
      prior_scope: prior.scope, prior_packet: prior.packet,
      prior_attempt_id: historical.attempt_id, prior_review_decision_id: historical.review_decision_id,
      receipt_sha256: historical.receipt_sha256, response_sha256: historical.response_sha256,
      response_utf8_bytes: historical.response_utf8_bytes,
      historical_provider_contact: "YES", historical_receipt_verdict: "REVISE",
      historical_receipt_effect: "VALID_REVIEW_RESULT", historical_operation_effect: "PARTIAL",
      body_state: "NOT_AVAILABLE_IN_MANAGED_STORES", historical_findings_reconstructed: false,
      historical_result_adopted: false, reexamination_scope: "ALL_TASK_CHANGES"
    });
  }

  private async readPriorReview(
    input: RepoRunFableReviewInput,
    target: ExactFableTarget
  ): Promise<PriorFableReview> {
    const artifactId = input.prior_review_artifact_id;
    if (!artifactId) throw new Error("STOP_MANAGED_PRIOR_REVIEW_REQUIRED");
    const content = await readWholeArtifact(this.artifacts, input.task_id, artifactId);
    const evidence = FableReviewEvidenceSchema.parse(JSON.parse(content));
    const priorOperation = await this.tasks.states.readOperation(input.task_id, evidence.operation_id);
    if (
      evidence.repo_id !== input.repo_id
      || priorOperation?.kind !== "FABLE_REVIEW"
      || priorOperation.phase !== "EXTERNAL_SUCCEEDED"
      || priorOperation.effect_state !== "PRESENT"
      || evidence.task_id !== input.task_id
      || evidence.review_state !== "review_completed"
      || evidence.provider_contact !== "YES"
      || evidence.effect_disposition !== "VALID_REVIEW_RESULT"
      || !evidence.lineage
      || !evidence.receipt
      || !evidence.review_result
      || !["REVISE", "BLOCK"].includes(evidence.review_result.review_status)
      || evidence.target.base_commit_sha !== target.base_commit_sha
      || evidence.target.base_tree_sha !== target.base_tree_sha
      || (evidence.target.head_sha === target.head_sha && evidence.target.tree_sha === target.tree_sha)
    ) {
      throw new Error("STOP_MANAGED_PRIOR_REVIEW_NOT_ELIGIBLE");
    }
    return { artifact_id: artifactId, evidence, receipt: evidence.receipt };
  }

  private async writeClaimOutcomeBestEffort(
    input: RepoRunFableReviewInput,
    preparation: FableReviewPreparation,
    outcome: NormalizedFableOutcome
  ): Promise<void> {
    await this.claims.writeOutcome({
      task_id: input.task_id,
      admission_key: preparation.admission_key,
      operation_id: input.operation_id,
      epoch_id: preparation.lineage.epoch_id,
      provider_contact: outcome.provider_contact,
      effect_disposition: outcome.effect_disposition,
      outcome_code: outcome.outcome_code,
      recorded_at: this.now().toISOString()
    }).catch(() => undefined);
  }

  private async publishEvidence(evidence: FableReviewEvidence): Promise<TaskArtifactMetadata> {
    const suffix = evidence.lineage?.epoch_id
      ?? hashedDiskKey("fable-operation", evidence.operation_id).slice(0, 32);
    return this.artifacts.put({
      task_id: evidence.task_id,
      kind: "review_evidence",
      media_type: "application/json",
      logical_path: `reviews/fable/${suffix}.json`,
      content: canonicalJson(evidence)
    });
  }
}

function evidenceRecord(
  input: RepoRunFableReviewInput,
  target: ExactFableTarget,
  scope: CanonicalFableScope,
  preparation: FableReviewPreparation | undefined,
  outcome: NormalizedFableOutcome,
  now: Date
): FableReviewEvidence {
  return FableReviewEvidenceSchema.parse({
    schema: preparation?.recovery
      ? "chat-pro-repository-managed-fable-review.v2" : "chat-pro-repository-managed-fable-review.v1",
    operation_id: input.operation_id,
    repo_id: input.repo_id,
    task_id: input.task_id,
    review_state: outcome.review_state,
    provider_contact: outcome.provider_contact,
    effect_disposition: outcome.effect_disposition,
    model_class: "FABLE",
    reasoning: "MAX",
    target,
    scope,
    ...(preparation ? { packet: preparation.packet, lineage: preparation.lineage } : {}),
    ...(preparation?.recovery ? { recovery: preparation.recovery } : {}),
    ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
    ...(outcome.review_result ? { review_result: outcome.review_result } : {}),
    outcome_code: outcome.outcome_code,
    retry_authorized: false,
    fallback_authorized: false,
    reroute_authorized: false,
    continuation_authorized: false,
    recorded_at: now.toISOString()
  });
}

function failedEvidence(
  input: RepoRunFableReviewInput,
  target: ExactFableTarget,
  scope: CanonicalFableScope,
  code: string,
  now: Date
): FableReviewEvidence {
  return evidenceRecord(
    input,
    target,
    scope,
    undefined,
    precontactFableOutcome(code),
    now
  );
}

function evidenceFailure(evidence: FableReviewEvidence, code: string): FableReviewEvidence {
  const outcome = evidence.provider_contact === "YES" ? contactedFableOutcome(code)
    : evidence.provider_contact === "NO" ? precontactFableOutcome(code) : unknownFableOutcome(code);
  const failed = { ...evidence, ...outcome };
  delete failed.receipt;
  delete failed.review_result;
  return FableReviewEvidenceSchema.parse(failed);
}

function resultEnvelope(
  evidence: FableReviewEvidence,
  warnings: string[],
  artifact?: TaskArtifactMetadata
): RepoRunFableReviewResult {
  return RepoRunFableReviewResultSchema.parse({
    ok: true,
    ...evidence,
    ...(artifact ? { artifact: artifactReference(artifact) } : {}),
    warnings
  });
}

function artifactReference(metadata: TaskArtifactMetadata) {
  return {
    artifact_id: metadata.artifact_id,
    kind: metadata.kind,
    media_type: metadata.media_type,
    byte_length: metadata.byte_length,
    sha256: metadata.content_sha256,
    created_at: metadata.created_at
  };
}

async function readWholeArtifact(
  artifacts: TaskArtifactStore,
  taskId: string,
  artifactId: string
): Promise<string> {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (true) {
    const read = await artifacts.read({
      task_id: taskId,
      artifact_id: artifactId,
      offset,
      length: ARTIFACT_WINDOW_BYTES
    });
    if (read.artifact.kind !== "review_evidence" || read.artifact.media_type !== "application/json") {
      throw new Error("STOP_MANAGED_PRIOR_REVIEW_ARTIFACT_INVALID");
    }
    const chunk = Buffer.from(read.content_base64, "base64");
    chunks.push(chunk);
    total += chunk.length;
    if (total > MAX_PRIOR_ARTIFACT_BYTES) {
      throw new Error("STOP_MANAGED_PRIOR_REVIEW_ARTIFACT_TOO_LARGE");
    }
    if (read.eof) return Buffer.concat(chunks).toString("utf8");
    offset += read.length;
  }
}

function duplicateOperation(operationId: string, phase: string): RepoReaderError {
  return new RepoReaderError(
    "TASK_OPERATION_CONFLICT",
    "operation_id is already bound to a managed Fable review and cannot be replayed.",
    { diagnostics: { operation_id: operationId, phase } }
  );
}

function isOperationConflict(error: unknown): boolean {
  return error instanceof RepoReaderError && error.code === "TASK_OPERATION_CONFLICT";
}

function hashedRequest(request: Record<string, unknown>): string {
  return sha256Hex(canonicalFableLauncherRequestBytes(request));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RepoReaderError) return safeFableOutcomeCode(error.code);
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return safeFableOutcomeCode(error.code);
  }
  if (error instanceof Error) return safeFableOutcomeCode(error.message);
  return "STOP_MANAGED_LOCAL_FAILURE";
}
