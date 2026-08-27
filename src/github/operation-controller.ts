import {
  GITHUB_OPERATION_PHASES,
  GitHubBoundaryError,
  type Clock,
  type DurableOperationLedger,
  type GitHubOperationPhase,
  type GitHubOperationRecord,
  type GitHubPublicSemantic,
  type JsonValue,
  sha256Json
} from "./types.js";

const ALLOWED_TRANSITIONS: Readonly<Record<GitHubOperationPhase, readonly GitHubOperationPhase[]>> = {
  CREATED: ["ADMITTED", "FAILED_PRECONTACT", "BLOCKED"],
  ADMITTED: ["LOCAL_MUTATION_STARTED", "EXTERNAL_PRECONTACT", "EXTERNAL_SUCCEEDED", "FAILED_PRECONTACT", "BLOCKED"],
  LOCAL_MUTATION_STARTED: ["LOCAL_MUTATION_COMPLETE", "ROLLBACK_COMPLETE", "BLOCKED"],
  LOCAL_MUTATION_COMPLETE: ["EXTERNAL_PRECONTACT", "EXTERNAL_SUCCEEDED", "BLOCKED"],
  EXTERNAL_PRECONTACT: ["EXTERNAL_CONTACTED", "EXTERNAL_SUCCEEDED", "FAILED_PRECONTACT", "BLOCKED"],
  EXTERNAL_CONTACTED: ["LOCAL_MUTATION_STARTED", "EXTERNAL_SUCCEEDED", "FAILED_KNOWN_AFTER_CONTACT", "UNKNOWN_AFTER_CONTACT", "BLOCKED"],
  EXTERNAL_SUCCEEDED: [],
  FAILED_PRECONTACT: [],
  FAILED_KNOWN_AFTER_CONTACT: [],
  UNKNOWN_AFTER_CONTACT: [],
  ROLLBACK_COMPLETE: [],
  BLOCKED: []
};

export type OperationAdmission =
  | { disposition: "EXECUTE"; record: GitHubOperationRecord }
  | { disposition: "STORED"; record: GitHubOperationRecord };

export class GitHubOperationController {
  constructor(
    private readonly ledger: DurableOperationLedger,
    private readonly clock: Clock
  ) {}

  async admit(input: {
    operationId: string;
    semantic: GitHubPublicSemantic;
    repoId: string;
    taskId: string;
    subject: JsonValue;
    binding: JsonValue;
  }): Promise<OperationAdmission> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(input.operationId)) {
      throw new GitHubBoundaryError("INVALID_OPERATION_ID", "operation_id is not a safe identifier.");
    }
    const now = this.clock.now().toISOString();
    const record: GitHubOperationRecord = {
      operationId: input.operationId,
      semantic: input.semantic,
      repoId: input.repoId,
      taskId: input.taskId,
      subjectDigest: sha256Json(input.subject),
      bindingDigest: sha256Json(input.binding),
      phase: "CREATED",
      createdAt: now,
      updatedAt: now
    };
    const created = await this.ledger.create(record);
    this.assertStoredIdentity(record, created.record);
    if (!created.created) {
      return { disposition: "STORED", record: created.record };
    }
    return {
      disposition: "EXECUTE",
      record: await this.transition(created.record, "ADMITTED")
    };
  }

  async transition(
    current: GitHubOperationRecord,
    nextPhase: GitHubOperationPhase,
    options: { result?: JsonValue; failureCode?: string } = {}
  ): Promise<GitHubOperationRecord> {
    if (!GITHUB_OPERATION_PHASES.includes(nextPhase)) {
      throw new GitHubBoundaryError("INVALID_OPERATION_PHASE", "Operation phase is not recognized.");
    }
    if (!ALLOWED_TRANSITIONS[current.phase].includes(nextPhase)) {
      throw new GitHubBoundaryError(
        "INVALID_OPERATION_TRANSITION",
        `Operation cannot transition from ${current.phase} to ${nextPhase}.`
      );
    }
    const updated = await this.ledger.transition({
      operationId: current.operationId,
      bindingDigest: current.bindingDigest,
      expectedPhases: [current.phase],
      nextPhase,
      updatedAt: this.clock.now().toISOString(),
      ...(options.result !== undefined ? { result: options.result } : {}),
      ...(options.failureCode ? { failureCode: options.failureCode } : {})
    });
    this.assertStoredIdentity(current, updated);
    return updated;
  }

  private assertStoredIdentity(expected: GitHubOperationRecord, actual: GitHubOperationRecord): void {
    if (
      actual.operationId !== expected.operationId
      || actual.bindingDigest !== expected.bindingDigest
      || actual.semantic !== expected.semantic
      || actual.repoId !== expected.repoId
      || actual.taskId !== expected.taskId
    ) {
      throw new GitHubBoundaryError(
        "OPERATION_ID_CONFLICT",
        "operation_id already exists with a different exact binding."
      );
    }
  }
}
