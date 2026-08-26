import { storeGitHubEvidence, type StoredGitHubEvidence } from "../github/evidence.js";
import { assertExactRemoteHead, bindExactTask, type ExactTaskInput } from "../github/exact-task.js";
import { GitHubOperationController } from "../github/operation-controller.js";
import { assertWritablePublicationTarget } from "./publication-target-guard.js";
import {
  GitHubBoundaryError,
  assertSha,
  sha256Json,
  type CheckRun,
  type Clock,
  type CommitStatus,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactCiEvidence,
  type ExactCiEvidenceReader,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubOperationRecord,
  type JsonValue,
  type RequiredCheckObservation,
  type ServerOwnedTask,
  type TaskLookup,
  type WorkflowRun
} from "../github/types.js";

export type CiStatusResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      ok: true;
      semantic: "repo_ci_status";
      operation_id: string;
      repo_id: string;
      task_id: string;
      evidence: ExactCiEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

export type CiRetryResult =
  | {
      disposition: "EXECUTED";
      operation: GitHubOperationRecord;
      ciStatusId: string;
      retriedRunIds: string[];
      skippedRunIds: string[];
      changed: true;
      evidence: StoredGitHubEvidence;
    }
  | { disposition: "STORED"; operation: GitHubOperationRecord };

type StoredCiSnapshot = {
  semantic: "repo_ci_status";
  repoId: string;
  taskId: string;
  headSha: string;
  overall: ExactCiEvidence["overall"];
  requiredChecks: RequiredCheckObservation[];
  workflowRuns: WorkflowRun[];
  observedAt: string;
};

export class GitHubCiService implements ExactCiEvidenceReader {
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

  async ciStatus(input: ExactTaskInput): Promise<CiStatusResult> {
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: false });
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_ci_status",
      repoId: task.repoId,
      taskId: task.taskId,
      subject: { headSha: input.expected_head_sha },
      binding: { expectedHeadSha: input.expected_head_sha, expectedTreeSha: input.expected_tree_sha }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      await assertExactRemoteHead(this.github, task, input.expected_head_sha, input.expected_tree_sha);
      const evidence = await this.getExactCiEvidence(task, input.expected_head_sha);
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: {
          ciStatusId: evidence.ciStatusId,
          headSha: evidence.headSha,
          overall: evidence.overall,
          artifactId: evidence.artifactId,
          artifactDigest: evidence.digest
        }
      });
      return {
        disposition: "EXECUTED",
        operation,
        ok: true,
        semantic: "repo_ci_status",
        operation_id: input.operation_id,
        repo_id: task.repoId,
        task_id: task.taskId,
        evidence
      };
    } catch (error) {
      operation = await this.operations.transition(operation, "FAILED_KNOWN_AFTER_CONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
  }

  async getExactCiEvidence(task: ServerOwnedTask, expectedHeadSha: string): Promise<ExactCiEvidence> {
    const headSha = assertSha(expectedHeadSha, "CI head sha");
    const [checkRuns, statuses, workflowRuns] = await Promise.all([
      this.collectCheckRuns(task, headSha),
      this.collectCommitStatuses(task, headSha),
      this.github.listWorkflowRunsForCommit(task.repository, headSha)
    ]);
    for (const run of workflowRuns) {
      if (run.headSha !== headSha) throw new GitHubBoundaryError("CI_RUN_HEAD_MISMATCH", "A workflow run is not bound to the exact CI head.");
    }
    const requiredChecks = normalizeRequiredChecks(task, checkRuns, statuses);
    const overall = overallCiStatus(requiredChecks, workflowRuns, checkRuns.length + statuses.length);
    const observedAt = this.clock.now().toISOString();
    const snapshot: StoredCiSnapshot = {
      semantic: "repo_ci_status",
      repoId: task.repoId,
      taskId: task.taskId,
      headSha,
      overall,
      requiredChecks,
      workflowRuns,
      observedAt
    };
    const stateDigest = sha256Json(ciStateJson(snapshot));
    const stored = await storeGitHubEvidence(this.artifacts, "github-ci-evidence", ciSnapshotJson(snapshot));
    return {
      ciStatusId: `ci_status_${stored.digest}`,
      digest: stored.digest,
      stateDigest,
      headSha,
      overall,
      requiredChecks,
      workflowRuns,
      observedAt,
      artifactId: stored.artifactId
    };
  }

  async writeCiRetryFailed(input: ExactTaskInput & {
    ci_status_id: string;
    failed_run_ids: string[];
  }): Promise<CiRetryResult> {
    if (input.failed_run_ids.length !== 1) {
      throw new GitHubBoundaryError("ONE_CI_RUN_REQUIRED", "Exactly one failed workflow run may be retried per operation.");
    }
    const runIdText = input.failed_run_ids[0]!;
    if (!/^[1-9][0-9]{0,19}$/.test(runIdText)) throw new GitHubBoundaryError("INVALID_RUN_ID", "Workflow run id is invalid.");
    const numericRunId = Number(runIdText);
    if (!Number.isSafeInteger(numericRunId)) throw new GitHubBoundaryError("INVALID_RUN_ID", "Workflow run id exceeds the safe integer boundary.");
    const subject = { headSha: input.expected_head_sha, runId: runIdText };
    return this.ledger.withSubjectLock({
      repoId: input.repo_id,
      taskId: input.task_id,
      semantic: "repo_write_ci_retry_failed",
      subjectDigest: sha256Json(subject)
    }, async () => this.writeCiRetryFailedLocked(input, runIdText, numericRunId, subject));
  }

  private async writeCiRetryFailedLocked(
    input: ExactTaskInput & { ci_status_id: string; failed_run_ids: string[] },
    runIdText: string,
    numericRunId: number,
    subject: { headSha: string; runId: string }
  ): Promise<CiRetryResult> {
    const { task } = await bindExactTask({ tasks: this.tasks, git: this.git, request: input, requireClean: true });
    const admission = await this.operations.admit({
      operationId: input.operation_id,
      semantic: "repo_write_ci_retry_failed",
      repoId: task.repoId,
      taskId: task.taskId,
      subject,
      binding: {
        expectedHeadSha: input.expected_head_sha,
        expectedTreeSha: input.expected_tree_sha,
        ciStatusId: input.ci_status_id,
        runId: runIdText
      }
    });
    if (admission.disposition === "STORED") return { disposition: "STORED", operation: admission.record };
    let operation = admission.record;
    try {
      const prior = await this.ledger.findBySubject({
        repoId: task.repoId,
        taskId: task.taskId,
        semantic: "repo_write_ci_retry_failed",
        subjectDigest: operation.subjectDigest
      });
      if (prior.some((record) => record.operationId !== operation.operationId && retryWasConsumed(record))) {
        operation = await this.operations.transition(operation, "BLOCKED", { failureCode: "CI_RETRY_ALREADY_CONSUMED" });
        throw operationError(new GitHubBoundaryError("CI_RETRY_ALREADY_CONSUMED", "The exact workflow run already consumed its one retry."), operation);
      }
    } catch (error) {
      if (isOperationError(error)) throw error;
      operation = await this.operations.transition(operation, "FAILED_PRECONTACT", { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
    let snapshot: StoredCiSnapshot;
    let runBefore: WorkflowRun;
    let evidence: StoredGitHubEvidence;
    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      const repository = await this.github.getRepository(task.repository);
      assertWritablePublicationTarget(task, repository);
      await assertExactRemoteHead(this.github, task, input.expected_head_sha, input.expected_tree_sha);
      snapshot = await this.loadCiSnapshot(input.ci_status_id);
      assertSnapshotBinding(snapshot, task, input.expected_head_sha);
      const matches = snapshot.workflowRuns.filter((run) => String(run.id) === runIdText);
      if (matches.length !== 1) throw new GitHubBoundaryError("CI_RUN_NOT_IN_SNAPSHOT", "The exact workflow run is not present once in the bound CI snapshot.");
      runBefore = matches[0]!;
      assertTransientRetryEligible(task, runBefore);
      const live = await this.github.getWorkflowRun(task.repository, numericRunId);
      assertSameRun(runBefore, live, input.expected_head_sha);
      assertTransientRetryEligible(task, live);
      operation = await this.operations.transition(operation, "LOCAL_MUTATION_STARTED");
      evidence = await storeGitHubEvidence(this.artifacts, "github-ci-evidence", {
        semantic: "repo_write_ci_retry_failed",
        repoId: task.repoId,
        taskId: task.taskId,
        headSha: input.expected_head_sha,
        ciStatusId: input.ci_status_id,
        runBefore: workflowRunJson(runBefore),
        deterministicTransientEvidence: {
          status: runBefore.status,
          conclusion: runBefore.conclusion ?? null,
          attempt: runBefore.attempt
        },
        preparedAt: this.clock.now().toISOString()
      });
      operation = await this.operations.transition(operation, "LOCAL_MUTATION_COMPLETE", {
        result: { artifactId: evidence.artifactId, artifactDigest: evidence.digest }
      });
    } catch (error) {
      if (isOperationError(error)) throw error;
      const phase = operation.phase === "EXTERNAL_CONTACTED" ? "FAILED_KNOWN_AFTER_CONTACT" : "BLOCKED";
      operation = await this.operations.transition(operation, phase, { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }

    operation = await this.operations.transition(operation, "EXTERNAL_PRECONTACT");
    operation = await this.operations.transition(operation, "EXTERNAL_CONTACTED");
    try {
      await this.github.retryFailedJobs(task.repository, numericRunId);
      const runAfter = await this.github.getWorkflowRun(task.repository, numericRunId);
      if (runAfter.id !== runBefore.id || runAfter.headSha !== input.expected_head_sha || runAfter.attempt <= runBefore.attempt) {
        throw new GitHubBoundaryError("CI_RETRY_READBACK_UNKNOWN", "Workflow run did not expose the exact successor attempt.", "UNKNOWN");
      }
      operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
        result: retryOperationResult(input.ci_status_id, runIdText, evidence, runAfter)
      });
      return {
        disposition: "EXECUTED",
        operation,
        ciStatusId: input.ci_status_id,
        retriedRunIds: [runIdText],
        skippedRunIds: [],
        changed: true,
        evidence
      };
    } catch (error) {
      try {
        const runAfter = await this.github.getWorkflowRun(task.repository, numericRunId);
        if (runAfter.id === runBefore.id && runAfter.headSha === input.expected_head_sha && runAfter.attempt > runBefore.attempt) {
          operation = await this.operations.transition(operation, "EXTERNAL_SUCCEEDED", {
            result: { ...retryOperationResult(input.ci_status_id, runIdText, evidence, runAfter), reconciled: true }
          });
          return {
            disposition: "EXECUTED",
            operation,
            ciStatusId: input.ci_status_id,
            retriedRunIds: [runIdText],
            skippedRunIds: [],
            changed: true,
            evidence
          };
        }
      } catch {
        // Preserve the original external effect classification.
      }
      const phase = error instanceof GitHubBoundaryError && error.effect === "KNOWN"
        ? "FAILED_KNOWN_AFTER_CONTACT"
        : "UNKNOWN_AFTER_CONTACT";
      operation = await this.operations.transition(operation, phase, { failureCode: errorCode(error) });
      throw operationError(error, operation);
    }
  }

  private async collectCheckRuns(task: ServerOwnedTask, sha: string): Promise<CheckRun[]> {
    const checks: CheckRun[] = [];
    let expectedTotal: number | undefined;
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.github.getCheckRunsPage({ repository: task.repository, sha, page });
      if (expectedTotal === undefined) expectedTotal = result.totalCount;
      if (result.totalCount !== expectedTotal || expectedTotal > 10_000) {
        throw new GitHubBoundaryError("CI_CHECK_SET_DRIFT", "Check-run pagination did not remain within the fixed snapshot bound.");
      }
      checks.push(...result.checkRuns);
      if (checks.length >= expectedTotal) break;
      if (result.checkRuns.length === 0) throw new GitHubBoundaryError("CI_CHECK_PAGINATION_INCOMPLETE", "Check-run pagination ended before total_count.");
      if (page === 100) throw new GitHubBoundaryError("CI_CHECK_LIMIT_EXCEEDED", "Check-run evidence exceeds the fixed page bound.");
    }
    if (checks.length !== expectedTotal) throw new GitHubBoundaryError("CI_CHECK_COUNT_MISMATCH", "Check-run evidence count does not match total_count.");
    if (new Set(checks.map((check) => check.id)).size !== checks.length) {
      throw new GitHubBoundaryError("CI_CHECK_DUPLICATE", "Check-run pagination returned duplicate ids.");
    }
    return checks;
  }

  private async collectCommitStatuses(task: ServerOwnedTask, sha: string): Promise<CommitStatus[]> {
    const statuses: CommitStatus[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.github.getCommitStatusesPage({ repository: task.repository, sha, page });
      if (result.sha !== sha) throw new GitHubBoundaryError("CI_STATUS_HEAD_MISMATCH", "Commit statuses are not bound to the exact CI head.");
      statuses.push(...result.statuses);
      if (result.statuses.length < 100) break;
      if (page === 100) throw new GitHubBoundaryError("CI_STATUS_LIMIT_EXCEEDED", "Commit-status evidence exceeds the fixed page bound.");
    }
    if (new Set(statuses.map((status) => status.id)).size !== statuses.length) {
      throw new GitHubBoundaryError("CI_STATUS_DUPLICATE", "Commit-status pagination returned duplicate ids.");
    }
    return statuses;
  }

  private async loadCiSnapshot(ciStatusId: string): Promise<StoredCiSnapshot> {
    const match = /^ci_status_([a-f0-9]{64})$/.exec(ciStatusId);
    if (!match) throw new GitHubBoundaryError("INVALID_CI_STATUS_ID", "ci_status_id is not a content-bound snapshot id.");
    const digest = match[1]!;
    const value = await this.artifacts.getJson({ namespace: "github-ci-evidence", digest });
    if (value === undefined || sha256Json(value) !== digest) {
      throw new GitHubBoundaryError("CI_SNAPSHOT_NOT_FOUND", "The exact content-bound CI snapshot is unavailable.");
    }
    return parseStoredCiSnapshot(value);
  }
}

function normalizeRequiredChecks(
  task: ServerOwnedTask,
  checkRuns: CheckRun[],
  statuses: CommitStatus[]
): RequiredCheckObservation[] {
  return task.requiredChecks.map((required): RequiredCheckObservation => {
    if (required.kind === "check_run") {
      const matches = checkRuns
        .filter((check) => check.name === required.name && check.appSlug === required.appSlug)
        .sort((left, right) => left.id - right.id);
      if (matches.length === 0) return { key: `check:${required.appSlug}:${required.name}`, required, status: "missing" };
      const providerStates = new Set(matches.map((check) => `${check.status}\0${check.conclusion ?? ""}`));
      if (providerStates.size > 1) {
        throw new GitHubBoundaryError(
          "CI_REQUIRED_CHECK_AMBIGUOUS",
          "A required check-run identity matched conflicting provider observations."
        );
      }
      const match = matches[0]!;
      const status = checkRunStatus(match);
      return {
        key: `check:${required.appSlug}:${required.name}`,
        required,
        status,
        sourceIds: matches.map((candidate) => candidate.id),
        ...(matches.length === 1 ? { sourceId: match.id } : {}),
        ...(match.conclusion ? { conclusion: match.conclusion } : {})
      };
    }
    const matches = statuses.filter((status) => status.context === required.context);
    if (matches.length > 1) throw new GitHubBoundaryError("CI_REQUIRED_STATUS_AMBIGUOUS", "A required commit-status identity matched more than once.");
    const match = matches[0];
    if (!match) return { key: `status:${required.context}`, required, status: "missing" };
    return {
      key: `status:${required.context}`,
      required,
      status: match.state === "success" ? "success" : match.state === "pending" ? "pending" : "failure",
      sourceId: match.id,
      conclusion: match.state
    };
  });
}

function checkRunStatus(check: CheckRun): RequiredCheckObservation["status"] {
  if (check.status !== "completed") return "pending";
  return check.conclusion === "success" ? "success" : "failure";
}

function overallCiStatus(
  required: RequiredCheckObservation[],
  workflowRuns: WorkflowRun[],
  providerCheckCount: number
): ExactCiEvidence["overall"] {
  if (required.some((check) => check.status === "failure" || check.status === "missing")) return "failure";
  if (required.some((check) => check.status === "pending")) return "pending";
  if (required.length > 0) return "success";
  if (providerCheckCount === 0 && workflowRuns.length === 0) return "no_runs";
  if (workflowRuns.some((run) => run.status !== "completed")) return "pending";
  if (workflowRuns.some((run) => run.conclusion !== "success")) return "failure";
  return "success";
}

function assertTransientRetryEligible(task: ServerOwnedTask, run: WorkflowRun): void {
  if (run.headSha.length !== 40 || run.attempt !== 1 || run.status !== "completed" || !run.conclusion) {
    throw new GitHubBoundaryError("CI_RETRY_NOT_ELIGIBLE", "Workflow run is not an exact first-attempt completed failure.");
  }
  if (!task.transientCiConclusions.includes(run.conclusion as never)) {
    throw new GitHubBoundaryError("CI_FAILURE_NOT_TRANSIENT", "Workflow run lacks configured deterministic transient-failure evidence.");
  }
}

function assertSameRun(snapshot: WorkflowRun, live: WorkflowRun, headSha: string): void {
  if (
    snapshot.id !== live.id
    || snapshot.headSha !== headSha
    || live.headSha !== headSha
    || snapshot.attempt !== live.attempt
    || snapshot.status !== live.status
    || snapshot.conclusion !== live.conclusion
  ) {
    throw new GitHubBoundaryError("CI_RUN_DRIFT", "Workflow run changed after the bound CI snapshot.");
  }
}

function assertSnapshotBinding(snapshot: StoredCiSnapshot, task: ServerOwnedTask, headSha: string): void {
  if (snapshot.repoId !== task.repoId || snapshot.taskId !== task.taskId || snapshot.headSha !== headSha) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_BINDING_MISMATCH", "CI snapshot does not match the exact task and head.");
  }
}

function retryWasConsumed(record: GitHubOperationRecord): boolean {
  return [
    "EXTERNAL_CONTACTED",
    "EXTERNAL_SUCCEEDED",
    "FAILED_KNOWN_AFTER_CONTACT",
    "UNKNOWN_AFTER_CONTACT",
    "BLOCKED"
  ].includes(record.phase);
}

function ciSnapshotJson(snapshot: StoredCiSnapshot): JsonValue {
  return {
    semantic: snapshot.semantic,
    repoId: snapshot.repoId,
    taskId: snapshot.taskId,
    headSha: snapshot.headSha,
    overall: snapshot.overall,
    requiredChecks: snapshot.requiredChecks.map(requiredCheckJson),
    workflowRuns: snapshot.workflowRuns.map(workflowRunJson),
    observedAt: snapshot.observedAt
  };
}

function ciStateJson(snapshot: StoredCiSnapshot): JsonValue {
  return {
    semantic: snapshot.semantic,
    repoId: snapshot.repoId,
    taskId: snapshot.taskId,
    headSha: snapshot.headSha,
    overall: snapshot.overall,
    requiredChecks: snapshot.requiredChecks.map(requiredCheckJson),
    workflowRuns: snapshot.workflowRuns.map(workflowRunJson)
  };
}

function requiredCheckJson(check: RequiredCheckObservation): JsonValue {
  const required: JsonValue = check.required.kind === "check_run"
    ? { kind: "check_run", name: check.required.name, appSlug: check.required.appSlug }
    : { kind: "commit_status", context: check.required.context };
  return {
    key: check.key,
    required,
    status: check.status,
    sourceId: check.sourceId ?? null,
    sourceIds: check.sourceIds ?? (check.sourceId === undefined ? [] : [check.sourceId]),
    conclusion: check.conclusion ?? null
  };
}

function workflowRunJson(run: WorkflowRun): JsonValue {
  return {
    id: run.id,
    headSha: run.headSha,
    attempt: run.attempt,
    status: run.status,
    conclusion: run.conclusion ?? null,
    workflowName: run.workflowName,
    event: run.event,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    url: run.url,
    jobs: run.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
      url: job.url,
      failureSummary: job.failureSummary
    }))
  };
}

function parseStoredCiSnapshot(value: JsonValue): StoredCiSnapshot {
  if (!isRecord(value) || value.semantic !== "repo_ci_status") throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "CI snapshot has an invalid fixed schema.");
  if (
    typeof value.repoId !== "string"
    || typeof value.taskId !== "string"
    || typeof value.headSha !== "string"
    || typeof value.observedAt !== "string"
    || !["pending", "success", "failure", "no_runs"].includes(String(value.overall))
    || !Array.isArray(value.requiredChecks)
    || !Array.isArray(value.workflowRuns)
  ) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "CI snapshot has an invalid fixed schema.");
  }
  const requiredChecks = value.requiredChecks.map(parseRequiredCheckObservation);
  const workflowRuns = value.workflowRuns.map(parseWorkflowRun);
  return {
    semantic: "repo_ci_status",
    repoId: value.repoId,
    taskId: value.taskId,
    headSha: assertSha(value.headSha, "stored CI head sha"),
    overall: value.overall as StoredCiSnapshot["overall"],
    requiredChecks,
    workflowRuns,
    observedAt: value.observedAt
  };
}

function parseRequiredCheckObservation(value: JsonValue): RequiredCheckObservation {
  if (!isRecord(value) || !isRecord(value.required) || typeof value.key !== "string") {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check evidence is invalid.");
  }
  const status = value.status;
  if (status !== "missing" && status !== "pending" && status !== "success" && status !== "failure") {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check status is invalid.");
  }
  const required = value.required.kind === "check_run"
    && typeof value.required.name === "string"
    && typeof value.required.appSlug === "string"
    ? { kind: "check_run" as const, name: value.required.name, appSlug: value.required.appSlug }
    : value.required.kind === "commit_status" && typeof value.required.context === "string"
      ? { kind: "commit_status" as const, context: value.required.context }
      : undefined;
  if (!required) throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check identity is invalid.");
  const sourceId = parseSourceId(value.sourceId);
  const sourceIds = parseSourceIds(value.sourceIds);
  assertSourceIdentity(sourceId, sourceIds);
  return {
    key: value.key,
    required,
    status,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(typeof value.conclusion === "string" ? { conclusion: value.conclusion } : {})
  };
}

function parseSourceId(value: JsonValue | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check source id is invalid.");
  }
  return value;
}

function parseSourceIds(value: JsonValue | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const sourceIds = Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
    : [];
  if (
    !Array.isArray(value)
    || sourceIds.length !== value.length
    || new Set(sourceIds).size !== sourceIds.length
    || sourceIds.some((sourceId, index) => index > 0 && sourceIds[index - 1]! >= sourceId)
  ) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check source ids are invalid.");
  }
  return sourceIds;
}

function assertSourceIdentity(sourceId: number | undefined, sourceIds: number[] | undefined): void {
  if (sourceIds === undefined) return;
  if (
    (sourceIds.length === 0 && sourceId !== undefined)
    || (sourceIds.length === 1 && sourceId !== sourceIds[0])
    || (sourceIds.length > 1 && sourceId !== undefined)
  ) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored required-check source identity is inconsistent.");
  }
}

function parseWorkflowRun(value: JsonValue): WorkflowRun {
  const validStatuses = new Set(["queued", "in_progress", "completed", "waiting", "pending", "requested"]);
  if (
    !isRecord(value)
    || typeof value.id !== "number"
    || typeof value.headSha !== "string"
    || typeof value.attempt !== "number"
    || typeof value.status !== "string"
    || !validStatuses.has(value.status)
    || typeof value.workflowName !== "string"
    || typeof value.event !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || typeof value.url !== "string"
    || !Array.isArray(value.jobs)
  ) {
    throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored workflow-run evidence is invalid.");
  }
  return {
    id: value.id,
    headSha: assertSha(value.headSha, "stored workflow run head sha"),
    attempt: value.attempt,
    status: value.status as WorkflowRun["status"],
    ...(typeof value.conclusion === "string" ? { conclusion: value.conclusion } : {}),
    workflowName: value.workflowName,
    event: value.event,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    url: value.url,
    jobs: value.jobs.map((job) => {
      if (
        !isRecord(job)
        || typeof job.id !== "number"
        || typeof job.name !== "string"
        || typeof job.status !== "string"
        || typeof job.url !== "string"
        || !Array.isArray(job.failureSummary)
        || !job.failureSummary.every((entry) => typeof entry === "string")
      ) {
        throw new GitHubBoundaryError("CI_SNAPSHOT_INVALID", "Stored workflow-job evidence is invalid.");
      }
      return {
        id: job.id,
        name: job.name,
        status: job.status as WorkflowRun["jobs"][number]["status"],
        ...(typeof job.conclusion === "string" ? { conclusion: job.conclusion } : {}),
        ...(typeof job.startedAt === "string" ? { startedAt: job.startedAt } : {}),
        ...(typeof job.completedAt === "string" ? { completedAt: job.completedAt } : {}),
        url: job.url,
        failureSummary: job.failureSummary
      };
    })
  };
}

function retryOperationResult(
  ciStatusId: string,
  runId: string,
  evidence: StoredGitHubEvidence,
  runAfter: WorkflowRun
): { [key: string]: JsonValue } {
  return {
    ciStatusId,
    retriedRunIds: [runId],
    skippedRunIds: [],
    changed: true,
    successorAttempt: runAfter.attempt,
    artifactId: evidence.artifactId,
    artifactDigest: evidence.digest
  };
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error instanceof GitHubBoundaryError ? error.code : "CI_OPERATION_FAILED";
}

type OperationBoundError = GitHubBoundaryError & { operation: GitHubOperationRecord };

function operationError(error: unknown, operation: GitHubOperationRecord): OperationBoundError {
  const boundary = error instanceof GitHubBoundaryError
    ? error
    : new GitHubBoundaryError("CI_OPERATION_FAILED", "CI operation failed without exposing external output.");
  return Object.assign(boundary, { operation });
}

function isOperationError(error: unknown): error is OperationBoundError {
  return error instanceof GitHubBoundaryError && "operation" in error;
}
