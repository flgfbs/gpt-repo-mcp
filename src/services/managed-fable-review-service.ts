import {
  FableReviewEvidenceSchema,
  RepoRunFableReviewInputSchema,
  RepoRunFableReviewResultSchema,
  type FableReviewEvidence,
  type RepoRunFableReviewInput,
  type RepoRunFableReviewResult
} from "../contracts/fable-review.contract.js";
import { RepoReaderError } from "../runtime/errors.js";
import { canonicalJson, hashedDiskKey, sha256Hex } from "../task-runtime/canonical-json.js";
import type { TaskArtifactMetadata, TaskArtifactStore } from "../task-runtime/artifact-store.js";
import type { ExactTaskMutationState, TaskRuntimeService } from "../task-runtime/task-service.js";
import { FableReviewClaimStore } from "./fable-review-claim-store.js";
import type { FableLauncherInvocation, FableLauncherPort } from "./fable-launcher-port.js";
import { canonicalFableLauncherRequestBytes } from "./fable-launcher-port.js";
import {
  normalizeFableInvocation,
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

  constructor(
    private readonly registry: RootRegistry,
    private readonly tasks: TaskRuntimeService,
    private readonly artifacts: TaskArtifactStore,
    private readonly launcher: FableLauncherPort,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.claims = new FableReviewClaimStore(tasks.fs);
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
    let stateChangedAfter = false;
    try {
      const locked = await this.tasks.runWithExactTaskState({
        task_id: input.task_id,
        expected_head: input.expected_head_sha,
        expected_tree: input.expected_tree_sha
      }, async (before) => this.runLocked(input, scope, target, before));
      evidence = locked.result;
      stateChangedAfter = (
        locked.after.head !== locked.before.head
        || locked.after.tree !== locked.before.tree
        || !locked.after.clean
      );
    } catch (error) {
      if (isOperationConflict(error)) throw error;
      return resultEnvelope(
        failedEvidence(input, target, scope, safeErrorCode(error), this.now()),
        []
      );
    }

    const warnings = stateChangedAfter ? ["TASK_STATE_CHANGED_AFTER_REVIEW_OPERATION"] : [];
    let artifact: TaskArtifactMetadata | undefined;
    try {
      artifact = await this.publishEvidence(evidence);
    } catch {
      warnings.push("FABLE_REVIEW_EVIDENCE_ARTIFACT_WRITE_FAILED");
    }
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
      preparation = await buildFableReviewPreparation({
        request: input,
        root: repo.root,
        target,
        scope,
        ...(prior ? { prior } : {}),
        scanner: this.scanner
      });
      const preflight = await this.launcher.preflight();
      validateFablePreflight(preflight);
      await this.claims.assertAdmissible(input.task_id, preparation.admission_key);
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
      contactBoundaryEntered = true;
      try {
        invocation = await this.launcher.invoke(prepared);
      } catch {
        const unknown = unknownFableOutcome("STOP_MANAGED_INVOKE_EFFECT_UNKNOWN");
        await this.writeClaimOutcomeBestEffort(input, preparation, unknown);
        await advanceFableReviewOperation(
          this.tasks,
          operation,
          "UNKNOWN_AFTER_CONTACT",
          "UNKNOWN",
          this.now(),
          unknown.outcome_code,
          input.repo_id
        );
        return evidenceRecord(input, target, scope, preparation, unknown, this.now());
      }

      let outcome = normalizeFableInvocation(invocation, preparation, input.review_kind);
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
      try {
        await this.claims.writeOutcome({
          task_id: input.task_id,
          admission_key: preparation.admission_key,
          operation_id: input.operation_id,
          epoch_id: preparation.lineage.epoch_id,
          provider_contact: outcome.provider_contact,
          effect_disposition: outcome.effect_disposition,
          outcome_code: outcome.outcome_code,
          recorded_at: this.now().toISOString()
        });
      } catch {
        outcome = unknownFableOutcome("STOP_MANAGED_OUTCOME_READBACK_UNKNOWN");
      }
      knownOutcome = outcome;
      await terminalizeFableReviewOperation(
        this.tasks,
        operation,
        outcome,
        input.repo_id,
        this.now()
      );
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

  private async readPriorReview(
    input: RepoRunFableReviewInput,
    target: ExactFableTarget
  ): Promise<PriorFableReview> {
    const artifactId = input.prior_review_artifact_id;
    if (!artifactId) throw new Error("STOP_MANAGED_PRIOR_REVIEW_REQUIRED");
    const content = await readWholeArtifact(this.artifacts, input.task_id, artifactId);
    const evidence = FableReviewEvidenceSchema.parse(JSON.parse(content));
    if (
      evidence.repo_id !== input.repo_id
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
    schema: "chat-pro-repository-managed-fable-review.v1",
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
