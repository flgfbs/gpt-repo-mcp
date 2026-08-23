import {
  GitHubBoundaryError,
  sha256,
  sha256Json,
  type CheckRunPage,
  type Clock,
  type CommitStatusPage,
  type CompareSnapshot,
  type ContentAddressedArtifactSink,
  type DurableOperationLedger,
  type ExactGitBoundary,
  type GitHubAdapter,
  type GitHubArtifactNamespace,
  type GitHubOperationRecord,
  type GitHubRefSnapshot,
  type GitHubRepositoryRef,
  type IndependentReviewEvidence,
  type JsonValue,
  type LocalGitSnapshot,
  type MergeApiResult,
  type MergeEvidenceProvider,
  type PullRequestSnapshot,
  type RepositorySnapshot,
  type ReviewComment,
  type ReviewReplyReceipt,
  type ReviewThread,
  type ReviewThreadPage,
  type ServerOwnedTask,
  type TaskLookup,
  type ValidationEvidence,
  type WorkflowRun
} from "../../src/github/types.js";

export const HEAD_SHA = "1111111111111111111111111111111111111111";
export const TREE_SHA = "2222222222222222222222222222222222222222";
export const BASE_SHA = "3333333333333333333333333333333333333333";
export const MERGE_SHA = "4444444444444444444444444444444444444444";
export const BASE_TREE_SHA = "5555555555555555555555555555555555555555";

export const FIXED_TASK: ServerOwnedTask = {
  repoId: "repo-1",
  taskId: "task-1",
  root: "/work/task-1",
  branch: "task/change",
  remoteName: "upstream",
  expectedRemoteIdentity: "github.com/example/project",
  repository: { owner: "example", name: "project" },
  baseBranch: "main",
  mergeMethod: "squash",
  requiredChecks: [{ kind: "check_run", name: "test", appSlug: "github-actions" }],
  transientCiConclusions: ["timed_out", "startup_failure", "stale"],
  independentReviewRequired: true
};

export class FixedClock implements Clock {
  constructor(private value = new Date("2026-08-23T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

export class FixedTaskLookup implements TaskLookup {
  constructor(readonly task = FIXED_TASK) {}

  async getServerOwnedTask(repoId: string): Promise<ServerOwnedTask> {
    if (repoId !== this.task.repoId) throw new GitHubBoundaryError("REPO_NOT_FOUND", "Repository not found.");
    return this.task;
  }
}

export class MemoryOperationLedger implements DurableOperationLedger {
  readonly records = new Map<string, GitHubOperationRecord>();
  readonly history: { operationId: string; phase: GitHubOperationRecord["phase"] }[] = [];

  async create(record: GitHubOperationRecord): Promise<{ created: boolean; record: GitHubOperationRecord }> {
    const existing = this.records.get(record.operationId);
    if (existing) return { created: false, record: structuredClone(existing) };
    this.records.set(record.operationId, structuredClone(record));
    this.history.push({ operationId: record.operationId, phase: record.phase });
    return { created: true, record: structuredClone(record) };
  }

  async transition(input: {
    operationId: string;
    bindingDigest: string;
    expectedPhases: GitHubOperationRecord["phase"][];
    nextPhase: GitHubOperationRecord["phase"];
    updatedAt: string;
    result?: JsonValue;
    failureCode?: string;
  }): Promise<GitHubOperationRecord> {
    const current = this.records.get(input.operationId);
    if (!current || current.bindingDigest !== input.bindingDigest || !input.expectedPhases.includes(current.phase)) {
      throw new GitHubBoundaryError("LEDGER_CAS_FAILED", "Operation ledger compare-and-set failed.");
    }
    const next: GitHubOperationRecord = {
      ...current,
      phase: input.nextPhase,
      updatedAt: input.updatedAt,
      ...(input.result !== undefined ? { result: structuredClone(input.result) } : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {})
    };
    this.records.set(input.operationId, next);
    this.history.push({ operationId: input.operationId, phase: input.nextPhase });
    return structuredClone(next);
  }

  async findBySubject(input: {
    repoId: string;
    taskId: string;
    semantic?: GitHubOperationRecord["semantic"];
    subjectDigest: string;
  }): Promise<GitHubOperationRecord[]> {
    return [...this.records.values()].filter((record) => (
      record.repoId === input.repoId
      && record.taskId === input.taskId
      && record.subjectDigest === input.subjectDigest
      && (input.semantic === undefined || record.semantic === input.semantic)
    )).map((record) => structuredClone(record));
  }

  async listForTask(input: { repoId: string; taskId: string }): Promise<GitHubOperationRecord[]> {
    return [...this.records.values()].filter((record) => (
      record.repoId === input.repoId && record.taskId === input.taskId
    )).map((record) => structuredClone(record));
  }
}

export class MemoryArtifactSink implements ContentAddressedArtifactSink {
  readonly values = new Map<string, JsonValue>();

  async putJson(input: {
    namespace: GitHubArtifactNamespace;
    digest: string;
    value: JsonValue;
    mode: 0o600;
  }): Promise<{ artifactId: string }> {
    if (input.mode !== 0o600 || sha256Json(input.value) !== input.digest) {
      throw new GitHubBoundaryError("ARTIFACT_DIGEST_MISMATCH", "Artifact is not exact content-addressed JSON.");
    }
    this.values.set(`${input.namespace}:${input.digest}`, structuredClone(input.value));
    return { artifactId: `artifact_${input.digest.slice(0, 24)}` };
  }

  async getJson(input: { namespace: GitHubArtifactNamespace; digest: string }): Promise<JsonValue | undefined> {
    const value = this.values.get(`${input.namespace}:${input.digest}`);
    return value === undefined ? undefined : structuredClone(value);
  }
}

export class FakeGitBoundary implements ExactGitBoundary {
  snapshot: LocalGitSnapshot = {
    branch: FIXED_TASK.branch,
    headSha: HEAD_SHA,
    treeSha: TREE_SHA,
    clean: true,
    pushUrls: ["https://github.com/example/project.git"],
    upstream: "origin/task/change"
  };
  pushCalls = 0;
  onPush?: () => void;
  pushError?: Error;

  async inspect(): Promise<LocalGitSnapshot> {
    return structuredClone(this.snapshot);
  }

  async isAncestor(): Promise<boolean> {
    return true;
  }

  async pushExact(): Promise<void> {
    this.pushCalls += 1;
    this.onPush?.();
    if (this.pushError) throw this.pushError;
  }
}

export class FakeGitHubAdapter implements GitHubAdapter {
  readonly calls: string[] = [];
  repository: RepositorySnapshot = {
    id: "R_repo_node",
    nameWithOwner: "example/project",
    defaultBranch: "main",
    archived: false,
    viewerPermission: "ADMIN",
    mergeMethods: { merge: true, squash: true, rebase: true }
  };
  refs = new Map<string, string>([
    [`refs/heads/${FIXED_TASK.branch}`, HEAD_SHA],
    [`refs/heads/${FIXED_TASK.baseBranch}`, BASE_SHA]
  ]);
  refTrees = new Map<string, string>([
    [`refs/heads/${FIXED_TASK.branch}`, TREE_SHA],
    [`refs/heads/${FIXED_TASK.baseBranch}`, BASE_TREE_SHA]
  ]);
  pullRequest: PullRequestSnapshot = makePullRequest();
  reviewThreads: ReviewThread[] = [];
  checkRuns: CheckRunPage = {
    totalCount: 1,
    checkRuns: [{
      id: 10,
      name: "test",
      appSlug: "github-actions",
      headSha: HEAD_SHA,
      status: "completed",
      conclusion: "success"
    }]
  };
  statuses: CommitStatusPage = { sha: HEAD_SHA, state: "success", statuses: [] };
  workflowRuns: WorkflowRun[] = [{
    id: 9001,
    headSha: HEAD_SHA,
    attempt: 1,
    status: "completed",
    conclusion: "success",
    workflowName: "CI",
    event: "push",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:30.000Z",
    url: "https://github.com/example/project/actions/runs/9001",
    jobs: [{
      id: 9101,
      name: "test",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:29.000Z",
      url: "https://github.com/example/project/actions/runs/9001/job/9101",
      failureSummary: []
    }]
  }];
  nextError = new Map<keyof GitHubAdapter, Error>();

  failNext(method: keyof GitHubAdapter, error: Error): void {
    this.nextError.set(method, error);
  }

  async getRepository(): Promise<RepositorySnapshot> {
    this.called("getRepository");
    return structuredClone(this.repository);
  }

  async getRef(_repository: GitHubRepositoryRef, qualifiedName: string): Promise<GitHubRefSnapshot | undefined> {
    this.called("getRef");
    const sha = this.refs.get(qualifiedName);
    const treeSha = this.refTrees.get(qualifiedName);
    return sha && treeSha ? { qualifiedName, sha, treeSha } : undefined;
  }

  async findOpenPullRequests(): Promise<PullRequestSnapshot[]> {
    this.called("findOpenPullRequests");
    return this.pullRequest.state === "OPEN" ? [structuredClone(this.pullRequest)] : [];
  }

  async getPullRequest(): Promise<PullRequestSnapshot> {
    this.called("getPullRequest");
    return structuredClone(this.pullRequest);
  }

  async createDraftPullRequest(input: {
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot> {
    this.called("createDraftPullRequest");
    const headSha = this.refs.get(`refs/heads/${input.headBranch}`);
    const baseSha = this.refs.get(`refs/heads/${input.baseBranch}`);
    if (!headSha || !baseSha) throw new GitHubBoundaryError("PR_REF_MISSING", "Draft PR refs are unavailable.");
    this.pullRequest = makePullRequest({
      title: input.title,
      titleDigest: sha256(input.title),
      bodyDigest: sha256(input.body),
      operationMarkers: markers(input.body),
      headRefName: input.headBranch,
      headSha,
      baseRefName: input.baseBranch,
      baseSha,
      isDraft: true
    });
    return structuredClone(this.pullRequest);
  }

  async updatePullRequest(input: { title: string; body: string; baseBranch: string }): Promise<PullRequestSnapshot> {
    this.called("updatePullRequest");
    this.pullRequest = {
      ...this.pullRequest,
      title: input.title,
      titleDigest: sha256(input.title),
      bodyDigest: sha256(input.body),
      operationMarkers: markers(input.body),
      baseRefName: input.baseBranch,
      updatedAt: "2026-08-23T00:01:00.000Z"
    };
    return structuredClone(this.pullRequest);
  }

  async markPullRequestReady(): Promise<PullRequestSnapshot> {
    this.called("markPullRequestReady");
    this.pullRequest = { ...this.pullRequest, isDraft: false, updatedAt: "2026-08-23T00:02:00.000Z" };
    return structuredClone(this.pullRequest);
  }

  async listReviewThreadsPage(input: { limit: number; cursor?: string }): Promise<ReviewThreadPage> {
    this.called("listReviewThreadsPage");
    const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0;
    const threads = this.reviewThreads.slice(offset, offset + input.limit).map((thread) => structuredClone(thread));
    const next = offset + threads.length;
    return {
      pullRequestId: this.pullRequest.id,
      pullRequestNumber: this.pullRequest.number,
      headSha: this.pullRequest.headSha,
      threads,
      ...(next < this.reviewThreads.length ? { nextCursor: `cursor:${next}` } : {})
    };
  }

  async replyToReviewThread(input: { threadId: string; body: string; operationMarker: string }): Promise<ReviewReplyReceipt> {
    this.called("replyToReviewThread");
    const comment = makeReviewComment(input.body, `comment_${input.operationMarker}`);
    const thread = this.reviewThreads.find((candidate) => candidate.id === input.threadId);
    if (thread) thread.comments.push(comment);
    return { comment, threadId: input.threadId, operationMarker: input.operationMarker };
  }

  async resolveReviewThread(input: { threadId: string }): Promise<ReviewThread> {
    this.called("resolveReviewThread");
    const thread = this.reviewThreads.find((candidate) => candidate.id === input.threadId);
    if (!thread) throw new GitHubBoundaryError("THREAD_NOT_FOUND", "Thread not found.", "KNOWN");
    thread.isResolved = true;
    return structuredClone(thread);
  }

  async getCheckRunsPage(input: { page: number }): Promise<CheckRunPage> {
    this.called("getCheckRunsPage");
    return input.page === 1 ? structuredClone(this.checkRuns) : { totalCount: this.checkRuns.totalCount, checkRuns: [] };
  }

  async getCommitStatusesPage(input: { page: number }): Promise<CommitStatusPage> {
    this.called("getCommitStatusesPage");
    return input.page === 1 ? structuredClone(this.statuses) : { sha: this.statuses.sha, state: this.statuses.state, statuses: [] };
  }

  async listWorkflowRunsForCommit(): Promise<WorkflowRun[]> {
    this.called("listWorkflowRunsForCommit");
    return structuredClone(this.workflowRuns);
  }

  async getWorkflowRun(_repository: GitHubRepositoryRef, runId: number): Promise<WorkflowRun> {
    this.called("getWorkflowRun");
    const run = this.workflowRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new GitHubBoundaryError("RUN_NOT_FOUND", "Run not found.");
    return structuredClone(run);
  }

  async retryFailedJobs(_repository: GitHubRepositoryRef, runId: number): Promise<void> {
    this.called("retryFailedJobs");
    const run = this.workflowRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new GitHubBoundaryError("RUN_NOT_FOUND", "Run not found.", "KNOWN");
    run.attempt += 1;
    run.status = "queued";
    run.updatedAt = "2026-08-23T00:01:00.000Z";
    delete run.conclusion;
  }

  async mergePullRequest(): Promise<MergeApiResult> {
    this.called("mergePullRequest");
    this.pullRequest = {
      ...this.pullRequest,
      state: "MERGED",
      mergedAt: "2026-08-23T00:03:00.000Z",
      mergeCommitSha: MERGE_SHA
    };
    this.refs.set(`refs/heads/${FIXED_TASK.baseBranch}`, MERGE_SHA);
    this.refTrees.set(`refs/heads/${FIXED_TASK.baseBranch}`, TREE_SHA);
    this.statuses.sha = MERGE_SHA;
    for (const check of this.checkRuns.checkRuns) check.headSha = MERGE_SHA;
    for (const run of this.workflowRuns) run.headSha = MERGE_SHA;
    return { merged: true, message: "MERGED", sha: MERGE_SHA };
  }

  async compare(_repository: GitHubRepositoryRef, baseSha: string, headSha: string): Promise<CompareSnapshot> {
    this.called("compare");
    return baseSha === MERGE_SHA && headSha === MERGE_SHA
      ? { status: "identical", aheadBy: 0, behindBy: 0, mergeBaseSha: MERGE_SHA }
      : { status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: baseSha };
  }

  private called(method: keyof GitHubAdapter): void {
    this.calls.push(method);
    const error = this.nextError.get(method);
    if (error) {
      this.nextError.delete(method);
      throw error;
    }
  }
}

export class FixedMergeEvidenceProvider implements MergeEvidenceProvider {
  validation: ValidationEvidence = {
    status: "passed",
    headSha: HEAD_SHA,
    treeSha: TREE_SHA,
    validationId: "validation-1",
    digest: "a".repeat(64)
  };
  review: IndependentReviewEvidence = {
    status: "passed",
    headSha: HEAD_SHA,
    treeSha: TREE_SHA,
    reviewId: "review-1",
    digest: "b".repeat(64),
    materialFindingCount: 0
  };

  async getValidationEvidence(): Promise<ValidationEvidence> {
    return structuredClone(this.validation);
  }

  async getIndependentReviewEvidence(): Promise<IndependentReviewEvidence> {
    return structuredClone(this.review);
  }
}

export function makePullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    id: "PR_node_1",
    number: 7,
    url: "https://github.com/example/project/pull/7",
    state: "OPEN",
    isDraft: true,
    title: "Change",
    headRefName: FIXED_TASK.branch,
    headSha: HEAD_SHA,
    baseRefName: FIXED_TASK.baseBranch,
    baseSha: BASE_SHA,
    titleDigest: sha256("Change"),
    bodyDigest: sha256("Body"),
    operationMarkers: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides
  };
}

export function makeReviewThread(id = "thread_1", resolved = false): ReviewThread {
  return {
    id,
    pullRequestId: "PR_node_1",
    pullRequestNumber: 7,
    headSha: HEAD_SHA,
    isResolved: resolved,
    isOutdated: false,
    path: "src/index.ts",
    line: 10,
    side: "RIGHT",
    comments: [makeReviewComment("Please adjust this.", "comment_1")],
    updatedAt: "2026-08-23T00:00:00.000Z"
  };
}

function makeReviewComment(body: string, id: string): ReviewComment {
  return {
    id,
    author: "reviewer",
    body,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    url: `https://github.com/example/project/pull/7#discussion_r${id.replace(/\D/g, "") || "1"}`
  };
}

function markers(body: string): string[] {
  return [...body.matchAll(/<!-- chat-pro-operation:([A-Za-z0-9][A-Za-z0-9._:-]{0,199}) -->/g)]
    .map((match) => match[1]!);
}
