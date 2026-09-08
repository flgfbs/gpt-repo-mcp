import { z } from "zod";
import {
  RepoWritePushReconciliationInputSchema, PushPublicationOutcomeSchema,
  type RepoWritePushReconciliationInput
} from "../contracts/push-reconciliation.contract.js";
import { bindExactTask } from "../github/exact-task.js";
import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import {
  GitHubBoundaryError, assertSafeExternalText, sha256, sha256Json,
  type Clock, type ContentAddressedArtifactSink, type DurableOperationLedger,
  type ExactGitBoundary, type GitHubAdapter, type GitHubOperationRecord,
  type JsonValue, type ServerOwnedTask, type TaskLookup
} from "../github/types.js";
import { assertWritablePublicationTarget } from "./publication-target-guard.js";
import { normalizeRemoteIdentity } from "./remote-identity.js";
import { assertSafeGitHubRemoteUrl } from "./git-remote-service.js";

const SEMANTIC = "repo_write_push_reconciliation" as const;
const NAMESPACE = "github-push-evidence" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const timestamp = z.string().datetime();
const RemoteObservationSchema = z.object({
  semantic: z.literal("repo_remote_status"), repoId: identifier, taskId: identifier,
  branch: z.string(), taskBranchName: z.string(), localHeadSha: oid, localTreeSha: oid,
  remoteHeadSha: oid, remoteTreeSha: oid, defaultBranchName: z.string(),
  defaultBranchHeadSha: oid, defaultBranchTreeSha: oid, localUpstream: z.string().nullable(),
  remoteName: z.string(), normalizedRemoteIdentity: z.string(), configuredRepositoryIdentity: z.string(),
  aligned: z.literal(true), relationship: z.literal("equal"), repositoryId: identifier
}).strict();
const RecordSchema = z.object({
  schema: z.literal("push-readback-reconciliation.v1"), semantic: z.literal(SEMANTIC),
  repoId: identifier, taskId: identifier, branch: z.string(), repositoryId: identifier,
  remoteIdentity: z.string(), headSha: oid, treeSha: oid,
  originalOperationId: identifier, originalStateSha256: digest,
  originalHeadSha: oid, originalTreeSha: oid, originalBindingDigest: digest,
  originalSubjectDigest: digest, originalFailureCode: z.string(), originalUpdatedAt: timestamp,
  observationOperationId: identifier, observationStateSha256: digest,
  observationEvidenceSha256: digest, observationCreatedAt: timestamp, observationUpdatedAt: timestamp,
  observationHeadSha: oid, observationTreeSha: oid,
  currentReadbackAt: timestamp, publication: PushPublicationOutcomeSchema,
  originalPushOutcome: z.literal("UNKNOWN"), originalFencePreserved: z.literal(true),
  pushReplayed: z.literal(false)
}).strict();
type ReconciliationRecord = z.infer<typeof RecordSchema>;
export type PushReconciliationResult = {
  record: ReconciliationRecord;
  operation?: GitHubOperationRecord;
  evidence?: StoredGitHubEvidence;
  stored?: boolean;
};

/** This interface can only discharge a PUSH unknown, never any other effect. */
export interface PushReconciliationVerifier {
  resolves(task: ServerOwnedTask, operation: GitHubOperationRecord, head: string, tree: string): Promise<boolean>;
}

export async function hasUnresolvedUnknownEffects(
  operations: GitHubOperationRecord[], task: ServerOwnedTask, head: string, tree: string,
  verifier?: PushReconciliationVerifier
): Promise<boolean> {
  for (const operation of operations) {
    if (operation.phase === "UNKNOWN_AFTER_CONTACT"
      && (!verifier || !(await verifier.resolves(task, operation, head, tree)))) return true;
  }
  return false;
}

export class GitHubPushReconciliationService implements PushReconciliationVerifier {
  private readonly operations: GitHubOperationController;
  constructor(
    private readonly tasks: TaskLookup,
    private readonly git: ExactGitBoundary,
    private readonly github: GitHubAdapter,
    private readonly artifacts: ContentAddressedArtifactSink,
    private readonly ledger: DurableOperationLedger,
    private readonly clock: Clock
  ) {
    this.operations = new GitHubOperationController(ledger, clock);
  }

  async reconcilePush(raw: RepoWritePushReconciliationInput): Promise<PushReconciliationResult> {
    const input = RepoWritePushReconciliationInputSchema.parse(raw);
    return this.ledger.withSubjectLock({
      repoId: input.repo_id, taskId: input.task_id, semantic: SEMANTIC,
      subjectDigest: sha256Json({ originalOperationId: input.original_operation_id })
    }, async () => {
      const record = await this.evaluate(input);
      if (input.dry_run) return { record };
      const admission = await this.operations.admit({
        operationId: input.operation_id, semantic: SEMANTIC, repoId: input.repo_id, taskId: input.task_id,
        subject: { originalOperationId: input.original_operation_id },
        binding: requestBinding(input)
      });
      if (admission.disposition === "STORED") {
        if (admission.record.phase !== "EXTERNAL_SUCCEEDED") fail("PUSH_RECONCILIATION_INCOMPLETE");
        const retained = await this.loadRecord(admission.record);
        await this.validateRetained(retained, input.expected_head_sha, input.expected_tree_sha);
        return { record: retained, operation: admission.record, stored: true };
      }
      let operation = await this.operations.transition(admission.record, "LOCAL_MUTATION_STARTED");
      try {
        // The evidence and its CAS object are immutable. Only the new operation is advanced.
        const evidence = await storeGitHubEvidence(this.artifacts, NAMESPACE, record);
        const retained = await this.exactEvidence(NAMESPACE, evidence.digest, evidence.artifactId);
        const parsed = RecordSchema.parse(retained);
        await this.validateRetained(parsed, input.expected_head_sha, input.expected_tree_sha);
        operation = await this.operations.transition(operation, "LOCAL_MUTATION_COMPLETE");
        operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
          result: { artifactId: evidence.artifactId, artifactDigest: evidence.digest }
        });
        return { record: parsed, operation, evidence };
      } catch (error) {
        if (operation.phase === "LOCAL_MUTATION_STARTED" || operation.phase === "LOCAL_MUTATION_COMPLETE") {
          await this.operations.transition(operation, "BLOCKED", { failureCode: "PUSH_RECONCILIATION_READBACK_FAILED" });
        }
        // Do not return raw adapter errors or adopt an orphaned evidence object.
        throw new GitHubBoundaryError(
          error instanceof GitHubBoundaryError ? error.code : "PUSH_RECONCILIATION_READBACK_FAILED",
          "Push reconciliation did not complete; the original unknown and no-replay fence are unchanged."
        );
      }
    });
  }

  async resolves(task: ServerOwnedTask, original: GitHubOperationRecord, head: string, tree: string): Promise<boolean> {
    if (original.semantic !== "repo_write_push" || original.phase !== "UNKNOWN_AFTER_CONTACT") return false;
    try {
      const candidates = await this.ledger.findBySubject({
        repoId: task.repoId, taskId: task.taskId, semantic: SEMANTIC,
        subjectDigest: sha256Json({ originalOperationId: original.operationId })
      });
      for (const candidate of candidates) {
        if (candidate.phase !== "EXTERNAL_SUCCEEDED") continue;
        const retained = await this.loadRecord(candidate);
        if (retained.headSha !== head || retained.treeSha !== tree) continue;
        if (retained.originalOperationId !== original.operationId) return false;
        await this.validateRetained(retained, head, tree);
        return true;
      }
    } catch {
      // Missing/tampered/unreadable evidence never relaxes a closure predicate.
    }
    return false;
  }

  private async loadRecord(operation: GitHubOperationRecord): Promise<ReconciliationRecord> {
    const result = z.object({ artifactId: identifier, artifactDigest: digest }).strict().parse(operation.result);
    const value = await this.exactEvidence(NAMESPACE, result.artifactDigest, result.artifactId);
    const record = RecordSchema.parse(value);
    if (operation.semantic !== SEMANTIC || operation.repoId !== record.repoId || operation.taskId !== record.taskId
      || operation.subjectDigest !== sha256Json({ originalOperationId: record.originalOperationId })
      || operation.bindingDigest !== sha256Json(requestBinding(recordInput(record, operation.operationId)))) {
      fail("PUSH_RECONCILIATION_BINDING_MISMATCH");
    }
    return record;
  }

  private async validateRetained(record: ReconciliationRecord, head: string, tree: string): Promise<void> {
    if (record.headSha !== head || record.treeSha !== tree) fail("PUSH_RECONCILIATION_STALE");
    const current = await this.evaluate(recordInput(record, "reconciliation-readback"));
    // Time advances, but every identity, historical digest and observation must still agree.
    const { currentReadbackAt: before, ...previousBinding } = record;
    const { currentReadbackAt: after, ...currentBinding } = current;
    if (Date.parse(before) > Date.parse(after)
      || sha256Json(previousBinding) !== sha256Json(currentBinding)) fail("PUSH_RECONCILIATION_STALE");
  }

  private async exact(operationId: string) {
    if (!this.ledger.readExact) fail("PUSH_RECONCILIATION_LEDGER_UNAVAILABLE");
    const bound = await this.ledger.readExact(operationId);
    if (!bound) fail("PUSH_RECONCILIATION_OPERATION_MISSING");
    digest.parse(bound.stateSha256);
    return bound;
  }

  private async exactEvidence(namespace: "github-push-evidence" | "github-remote-evidence", hash: string, artifactId: string) {
    if (!this.artifacts.getExactJson) fail("PUSH_RECONCILIATION_ARTIFACT_CAPABILITY_UNAVAILABLE");
    const result = await this.artifacts.getExactJson({ namespace, digest: hash });
    if (!result || result.artifactId !== artifactId || sha256Json(result.value) !== hash) {
      fail("PUSH_RECONCILIATION_READBACK_FAILED");
    }
    return result.value;
  }

  private async evaluate(input: RepoWritePushReconciliationInput): Promise<ReconciliationRecord> {
    const { task, local } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
    if (local.pushUrls.length !== 1 || normalizeRemoteIdentity(local.pushUrls[0]!) !== task.expectedRemoteIdentity) {
      fail("PUSH_RECONCILIATION_REMOTE_DRIFT");
    }
    assertSafeGitHubRemoteUrl(local.pushUrls[0]!, task.expectedRemoteIdentity, task.repository);
    const original = await this.exact(input.original_operation_id);
    const observation = await this.exact(input.observation_operation_id);
    const old = original.record;
    const observed = observation.record;
    if (old.operationId === observed.operationId || old.repoId !== task.repoId || old.taskId !== task.taskId
      || old.semantic !== "repo_write_push" || old.phase !== "UNKNOWN_AFTER_CONTACT"
      || !["PUSH_READBACK_MISMATCH", "PUSH_READBACK_UNAVAILABLE", "PUSH_REMOTE_DRIFT"].includes(old.failureCode ?? "")) {
      fail("PUSH_RECONCILIATION_UNSUPPORTED_EFFECT");
    }
    if ((input.expected_original_state_sha256 && input.expected_original_state_sha256 !== original.stateSha256)
      || (input.expected_observation_state_sha256 && input.expected_observation_state_sha256 !== observation.stateSha256)) {
      fail("PUSH_RECONCILIATION_STATE_DRIFT");
    }
    if (old.subjectDigest !== sha256Json({ branch: task.branch })
      || old.bindingDigest !== sha256Json({
        branch: task.branch, expectedHeadSha: input.original_head_sha, expectedTreeSha: input.original_tree_sha,
        remoteIdentityDigest: sha256(task.expectedRemoteIdentity)
      })) fail("PUSH_RECONCILIATION_ORIGINAL_BINDING_MISMATCH");
    if (observed.repoId !== task.repoId || observed.taskId !== task.taskId
      || observed.semantic !== "repo_remote_status" || observed.phase !== "EXTERNAL_SUCCEEDED"
      || observed.subjectDigest !== sha256Json({ branch: task.branch })) fail("PUSH_RECONCILIATION_OBSERVATION_INVALID");
    const result = z.object({
      remoteHeadSha: oid, remoteTreeSha: oid, aligned: z.literal(true), relationship: z.literal("equal"),
      artifactId: identifier, artifactDigest: digest
    }).strict().parse(observed.result);
    const raw = await this.exactEvidence("github-remote-evidence", result.artifactDigest, result.artifactId);
    assertSafeExternalText(JSON.stringify(raw), "push observation", [task.root]);
    const evidence = RemoteObservationSchema.parse(raw);
    if (evidence.repoId !== task.repoId || evidence.taskId !== task.taskId
      || evidence.branch !== task.branch || evidence.taskBranchName !== task.branch
      || evidence.normalizedRemoteIdentity !== task.expectedRemoteIdentity || evidence.remoteName !== task.remoteName
      || evidence.localHeadSha !== evidence.remoteHeadSha || evidence.localTreeSha !== evidence.remoteTreeSha
      || result.remoteHeadSha !== evidence.remoteHeadSha || result.remoteTreeSha !== evidence.remoteTreeSha
      || observed.bindingDigest !== sha256Json({
        expectedHeadSha: evidence.localHeadSha, expectedTreeSha: evidence.localTreeSha
      })) fail("PUSH_RECONCILIATION_OBSERVATION_INVALID");
    const now = this.clock.now().toISOString();
    const times = [old.createdAt, old.updatedAt, observed.createdAt, observed.updatedAt, now].map(value => Date.parse(timestamp.parse(value)));
    if (times[2]! <= times[1]!
      || times.some((value, index) => index > 0 && value < times[index - 1]!)) fail("PUSH_RECONCILIATION_TIME_INVALID");
    if (evidence.remoteHeadSha === input.original_head_sha && evidence.remoteTreeSha !== input.original_tree_sha) {
      fail("PUSH_RECONCILIATION_OBSERVATION_INVALID");
    }
    if (!(await this.git.isAncestor(task, input.original_head_sha, evidence.remoteHeadSha))
      || !(await this.git.isAncestor(task, evidence.remoteHeadSha, input.expected_head_sha))) {
      fail("PUSH_RECONCILIATION_ANCESTRY_INVALID");
    }
    // An archived observation proves later publication, not current closure.
    const repository = await this.github.getRepository(task.repository);
    assertWritablePublicationTarget(task, repository);
    if (repository.id !== evidence.repositoryId || repository.nameWithOwner !== evidence.configuredRepositoryIdentity) {
      fail("PUSH_RECONCILIATION_REPOSITORY_DRIFT");
    }
    // Local ancestry alone is not authoritative publication evidence.
    for (const [base, head] of [
      [input.original_head_sha, evidence.remoteHeadSha],
      [evidence.remoteHeadSha, input.expected_head_sha]
    ] as const) {
      if (base === head) continue;
      const comparison = await this.github.compare(task.repository, base, head);
      if (comparison.status !== "ahead" || comparison.behindBy !== 0 || comparison.aheadBy < 1
        || comparison.mergeBaseSha !== base) fail("PUSH_RECONCILIATION_ANCESTRY_INVALID");
    }
    const remote = await this.github.getRef(task.repository, "refs/heads/" + task.branch);
    if (remote?.qualifiedName !== "refs/heads/" + task.branch
      || remote.sha !== input.expected_head_sha || remote.treeSha !== input.expected_tree_sha) {
      fail("PUSH_RECONCILIATION_CURRENT_READBACK_MISMATCH");
    }
    // Bookend the external reads: local or retained-state drift invalidates this observation.
    const rebound = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
    if (sha256Json(rebound.task) !== sha256Json(task) || sha256Json(rebound.local) !== sha256Json(local)
      || (await this.exact(old.operationId)).stateSha256 !== original.stateSha256
      || (await this.exact(observed.operationId)).stateSha256 !== observation.stateSha256) {
      fail("PUSH_RECONCILIATION_STATE_DRIFT");
    }
    const record = RecordSchema.parse({
      schema: "push-readback-reconciliation.v1", semantic: SEMANTIC,
      repoId: task.repoId, taskId: task.taskId, branch: task.branch, repositoryId: repository.id,
      remoteIdentity: task.expectedRemoteIdentity, headSha: input.expected_head_sha, treeSha: input.expected_tree_sha,
      originalOperationId: old.operationId, originalStateSha256: original.stateSha256,
      originalHeadSha: input.original_head_sha, originalTreeSha: input.original_tree_sha,
      originalBindingDigest: old.bindingDigest, originalSubjectDigest: old.subjectDigest,
      originalFailureCode: old.failureCode, originalUpdatedAt: old.updatedAt,
      observationOperationId: observed.operationId, observationStateSha256: observation.stateSha256,
      observationEvidenceSha256: result.artifactDigest, observationCreatedAt: observed.createdAt,
      observationUpdatedAt: observed.updatedAt, observationHeadSha: evidence.remoteHeadSha,
      observationTreeSha: evidence.remoteTreeSha, currentReadbackAt: this.clock.now().toISOString(),
      publication: evidence.remoteHeadSha === input.original_head_sha ? "EXACT_PUBLICATION_CONFIRMED" : "LATER_PUBLICATION_CONFIRMED",
      originalPushOutcome: "UNKNOWN", originalFencePreserved: true, pushReplayed: false
    });
    assertSafeExternalText(JSON.stringify(record), "push reconciliation", [task.root]);
    return record;
  }
}

function recordInput(record: ReconciliationRecord, operationId: string): RepoWritePushReconciliationInput {
  return {
    operation_id: operationId, repo_id: record.repoId, task_id: record.taskId,
    expected_head_sha: record.headSha, expected_tree_sha: record.treeSha,
    original_operation_id: record.originalOperationId, original_head_sha: record.originalHeadSha,
    original_tree_sha: record.originalTreeSha, observation_operation_id: record.observationOperationId,
    expected_original_state_sha256: record.originalStateSha256,
    expected_observation_state_sha256: record.observationStateSha256, dry_run: false
  };
}

function requestBinding(input: RepoWritePushReconciliationInput): JsonValue {
  return {
    repo_id: input.repo_id, task_id: input.task_id,
    expected_head_sha: input.expected_head_sha, expected_tree_sha: input.expected_tree_sha,
    original_operation_id: input.original_operation_id,
    original_head_sha: input.original_head_sha, original_tree_sha: input.original_tree_sha,
    observation_operation_id: input.observation_operation_id,
    ...(input.expected_original_state_sha256 ? { expected_original_state_sha256: input.expected_original_state_sha256 } : {}),
    ...(input.expected_observation_state_sha256 ? { expected_observation_state_sha256: input.expected_observation_state_sha256 } : {})
  };
}

function fail(code: string): never {
  throw new GitHubBoundaryError(code, "Push reconciliation evidence is unavailable, unsafe, stale, or mismatched.");
}
