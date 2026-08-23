import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { redactSecretValues } from "../policies/secret-patterns.js";

export const GITHUB_PUBLIC_SEMANTICS = [
  "repo_remote_status",
  "repo_write_push",
  "repo_pr_create_or_update",
  "repo_pr_status",
  "repo_pr_review_threads",
  "repo_write_pr_reply",
  "repo_write_pr_resolve_thread",
  "repo_ci_status",
  "repo_write_ci_retry_failed",
  "repo_merge_gate_prepare",
  "repo_write_merge",
  "repo_post_merge_readback"
] as const;

export type GitHubPublicSemantic = typeof GITHUB_PUBLIC_SEMANTICS[number];

export const GITHUB_OPERATION_PHASES = [
  "CREATED",
  "ADMITTED",
  "LOCAL_MUTATION_STARTED",
  "LOCAL_MUTATION_COMPLETE",
  "EXTERNAL_PRECONTACT",
  "EXTERNAL_CONTACTED",
  "EXTERNAL_SUCCEEDED",
  "FAILED_PRECONTACT",
  "FAILED_KNOWN_AFTER_CONTACT",
  "UNKNOWN_AFTER_CONTACT",
  "ROLLBACK_COMPLETE",
  "BLOCKED"
] as const;

export type GitHubOperationPhase = typeof GITHUB_OPERATION_PHASES[number];
export type MergeMethod = "merge" | "squash" | "rebase";
export type TransientCiConclusion = "timed_out" | "startup_failure" | "stale";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RequiredCheck =
  | { kind: "check_run"; name: string; appSlug: string }
  | { kind: "commit_status"; context: string };

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
};

export type ServerOwnedTask = {
  repoId: string;
  taskId: string;
  root: string;
  branch: string;
  remoteName: string;
  expectedRemoteIdentity: string;
  repository: GitHubRepositoryRef;
  baseBranch: string;
  mergeMethod: MergeMethod;
  requiredChecks: RequiredCheck[];
  transientCiConclusions: TransientCiConclusion[];
  independentReviewRequired?: boolean;
};

export interface TaskLookup {
  getServerOwnedTask(repoId: string): Promise<ServerOwnedTask>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date()
};

export interface RuntimeRootProvider {
  getRuntimeRoot(): Promise<string>;
}

export type GitHubOperationRecord = {
  operationId: string;
  semantic: GitHubPublicSemantic;
  repoId: string;
  taskId: string;
  subjectDigest: string;
  bindingDigest: string;
  phase: GitHubOperationPhase;
  createdAt: string;
  updatedAt: string;
  result?: JsonValue;
  failureCode?: string;
};

export interface DurableOperationLedger {
  withSubjectLock<T>(input: {
    repoId: string;
    taskId: string;
    semantic: GitHubPublicSemantic;
    subjectDigest: string;
  }, action: () => Promise<T>): Promise<T>;
  create(record: GitHubOperationRecord): Promise<{ created: boolean; record: GitHubOperationRecord }>;
  transition(input: {
    operationId: string;
    bindingDigest: string;
    expectedPhases: GitHubOperationPhase[];
    nextPhase: GitHubOperationPhase;
    updatedAt: string;
    result?: JsonValue;
    failureCode?: string;
  }): Promise<GitHubOperationRecord>;
  findBySubject(input: {
    repoId: string;
    taskId: string;
    semantic?: GitHubPublicSemantic;
    subjectDigest: string;
  }): Promise<GitHubOperationRecord[]>;
  listForTask(input: { repoId: string; taskId: string }): Promise<GitHubOperationRecord[]>;
}

export interface ContentAddressedArtifactSink {
  putJson(input: {
    namespace: GitHubArtifactNamespace;
    digest: string;
    value: JsonValue;
    mode: 0o600;
  }): Promise<{ artifactId: string }>;
  getJson(input: {
    namespace: GitHubArtifactNamespace;
    digest: string;
  }): Promise<JsonValue | undefined>;
}

export type GitHubArtifactNamespace =
  | "github-remote-evidence"
  | "github-push-evidence"
  | "github-pr-evidence"
  | "github-merge-gates"
  | "github-ci-evidence"
  | "github-review-evidence"
  | "github-merge-evidence"
  | "github-post-merge-evidence";

export type LocalGitSnapshot = {
  branch: string;
  headSha: string;
  treeSha: string;
  clean: boolean;
  pushUrls: string[];
  upstream?: string;
};

export interface ExactGitBoundary {
  inspect(task: ServerOwnedTask): Promise<LocalGitSnapshot>;
  isAncestor(task: ServerOwnedTask, ancestorSha: string, descendantSha: string): Promise<boolean>;
  pushExact(input: {
    task: ServerOwnedTask;
    expectedHeadSha: string;
    expectedRemoteUrl: string;
  }): Promise<void>;
}

export type RepositorySnapshot = {
  id: string;
  nameWithOwner: string;
  defaultBranch: string;
  archived: boolean;
  viewerPermission: string;
  mergeMethods: Record<MergeMethod, boolean>;
};

export type GitHubRefSnapshot = {
  qualifiedName: string;
  sha: string;
  treeSha: string;
};

export type PullRequestSnapshot = {
  id: string;
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  baseSha: string;
  titleDigest: string;
  bodyDigest: string;
  operationMarkers: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision?: string;
  updatedAt: string;
  mergedAt?: string;
  mergeCommitSha?: string;
};

export type ReviewThread = {
  id: string;
  pullRequestId: string;
  pullRequestNumber: number;
  headSha: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line?: number;
  originalLine?: number;
  side?: "LEFT" | "RIGHT";
  comments: ReviewComment[];
  updatedAt: string;
};

export type ReviewComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type ReviewThreadPage = {
  pullRequestId: string;
  pullRequestNumber: number;
  headSha: string;
  threads: ReviewThread[];
  nextCursor?: string;
};

export type ReviewReplyReceipt = {
  comment: ReviewComment;
  threadId: string;
  operationMarker: string;
};

export type CheckRun = {
  id: number;
  name: string;
  appSlug: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending" | "requested";
  conclusion?: string;
};

export type CheckRunPage = {
  totalCount: number;
  checkRuns: CheckRun[];
};

export type CommitStatus = {
  id: number;
  context: string;
  state: "error" | "failure" | "pending" | "success";
};

export type CommitStatusPage = {
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  statuses: CommitStatus[];
};

export type WorkflowRun = {
  id: number;
  headSha: string;
  attempt: number;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending" | "requested";
  conclusion?: string;
  workflowName: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  jobs: WorkflowJob[];
};

export type WorkflowJob = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending" | "requested";
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url: string;
  failureSummary: string[];
};

export type RequiredCheckObservation = {
  key: string;
  required: RequiredCheck;
  status: "missing" | "pending" | "success" | "failure";
  sourceId?: number;
  sourceIds?: number[];
  conclusion?: string;
};

export type ExactCiEvidence = {
  ciStatusId: string;
  digest: string;
  stateDigest: string;
  headSha: string;
  overall: "pending" | "success" | "failure" | "no_runs";
  requiredChecks: RequiredCheckObservation[];
  workflowRuns: WorkflowRun[];
  observedAt: string;
  artifactId: string;
};

export interface ExactCiEvidenceReader {
  getExactCiEvidence(task: ServerOwnedTask, expectedHeadSha: string): Promise<ExactCiEvidence>;
}

export type MergeApiResult = {
  merged: boolean;
  message: string;
  sha?: string;
};

export type CompareSnapshot = {
  status: "ahead" | "behind" | "diverged" | "identical";
  aheadBy: number;
  behindBy: number;
  mergeBaseSha: string;
};

export interface GitHubAdapter {
  getRepository(repository: GitHubRepositoryRef): Promise<RepositorySnapshot>;
  getRef(repository: GitHubRepositoryRef, qualifiedName: string): Promise<GitHubRefSnapshot | undefined>;
  findOpenPullRequests(input: {
    repository: GitHubRepositoryRef;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot[]>;
  getPullRequest(repository: GitHubRepositoryRef, number: number): Promise<PullRequestSnapshot>;
  createDraftPullRequest(input: {
    repository: GitHubRepositoryRef;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot>;
  updatePullRequest(input: {
    repository: GitHubRepositoryRef;
    number: number;
    title: string;
    body: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot>;
  markPullRequestReady(repository: GitHubRepositoryRef, pullRequestId: string): Promise<PullRequestSnapshot>;
  listReviewThreadsPage(input: {
    repository: GitHubRepositoryRef;
    pullRequestNumber: number;
    limit: number;
    cursor?: string;
  }): Promise<ReviewThreadPage>;
  replyToReviewThread(input: {
    repository: GitHubRepositoryRef;
    threadId: string;
    body: string;
    operationMarker: string;
  }): Promise<ReviewReplyReceipt>;
  resolveReviewThread(input: {
    repository: GitHubRepositoryRef;
    threadId: string;
  }): Promise<ReviewThread>;
  getCheckRunsPage(input: {
    repository: GitHubRepositoryRef;
    sha: string;
    page: number;
  }): Promise<CheckRunPage>;
  getCommitStatusesPage(input: {
    repository: GitHubRepositoryRef;
    sha: string;
    page: number;
  }): Promise<CommitStatusPage>;
  listWorkflowRunsForCommit(repository: GitHubRepositoryRef, sha: string): Promise<WorkflowRun[]>;
  getWorkflowRun(repository: GitHubRepositoryRef, runId: number): Promise<WorkflowRun>;
  retryFailedJobs(repository: GitHubRepositoryRef, runId: number): Promise<void>;
  mergePullRequest(input: {
    repository: GitHubRepositoryRef;
    number: number;
    expectedHeadSha: string;
    method: MergeMethod;
  }): Promise<MergeApiResult>;
  compare(repository: GitHubRepositoryRef, baseSha: string, headSha: string): Promise<CompareSnapshot>;
}

export type ValidationEvidence = {
  status: "passed" | "failed" | "missing";
  headSha: string;
  treeSha: string;
  validationId: string;
  digest: string;
  createdAt?: string;
};

export type IndependentReviewEvidence = {
  status: "passed" | "failed" | "missing";
  headSha: string;
  treeSha: string;
  reviewId: string;
  digest: string;
  materialFindingCount?: number;
};

export interface MergeEvidenceProvider {
  getValidationEvidence(task: ServerOwnedTask): Promise<ValidationEvidence>;
  getIndependentReviewEvidence(task: ServerOwnedTask): Promise<IndependentReviewEvidence>;
}

export type MergeGateManifestCore = {
  repoId: string;
  taskId: string;
  repositoryId: string;
  repositoryNameWithOwner: string;
  pullRequestId: string;
  pullRequestNumber: number;
  pullRequestState: "OPEN";
  pullRequestDraft: true;
  pullRequestMergeable: "MERGEABLE";
  baseBranch: string;
  baseSha: string;
  taskBranch: string;
  headSha: string;
  treeSha: string;
  mergeMethod: MergeMethod;
  deleteTaskBranch: false;
  retainTaskBranch: true;
  requiredRunIds: string[];
  unresolvedThreadIds: string[];
  ciStatusId: string;
  ciEvidenceDigest: string;
  validationId: string;
  validationDigest: string;
  independentReviewId: string;
  independentReviewDigest: string;
  independentReviewRequired: boolean;
  materialFindingCount: 0;
  postMergePlan: {
    readbackRequired: true;
    retainTaskBranch: true;
    verifyBaseContainsHead: true;
  };
  preparedAt: string;
  expiresAt: string;
};

export type MergeGateManifest = MergeGateManifestCore & {
  manifestId: string;
  manifestSha256: string;
  artifactId?: string;
};

export class GitHubBoundaryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: "NONE" | "KNOWN" | "UNKNOWN" = "NONE",
    readonly transient = false
  ) {
    super(message);
    this.name = "GitHubBoundaryError";
  }
}

export function repositorySlug(repository: GitHubRepositoryRef): string {
  assertRepositoryPart(repository.owner, "owner");
  assertRepositoryPart(repository.name, "repository");
  return `${repository.owner}/${repository.name}`;
}

export function assertSha(value: string, field = "sha"): string {
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new GitHubBoundaryError("INVALID_SHA", `${field} must be an exact 40-character lowercase Git SHA.`);
  }
  return value;
}

export function assertSafeIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new GitHubBoundaryError("INVALID_IDENTIFIER", `${field} is not a safe identifier.`);
  }
  return value;
}

export function assertSafeBranch(value: string): string {
  if (
    value.length === 0
    || value.length > 200
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("..")
    || value.includes("@{")
    || /[\s~^:?*[\]\\]/.test(value)
  ) {
    throw new GitHubBoundaryError("INVALID_BRANCH", "Branch is not a safe task branch.");
  }
  return value;
}

export function assertSafeExternalText(value: string, field: string, forbiddenRoots: string[] = []): string {
  if (value.length === 0 || value.includes("\0")) {
    throw new GitHubBoundaryError("UNSAFE_EXTERNAL_TEXT", `${field} is empty or contains NUL.`);
  }
  if (redactSecretValues(value) !== value) {
    throw new GitHubBoundaryError("SECRET_IN_EXTERNAL_TEXT", `${field} contains secret-looking content.`);
  }
  const platformPath = /(?:^|[\s('"`])(?:file:\/\/|\/(?:Users|home|private|var|tmp|Volumes|opt|root)\/|[A-Za-z]:\\|\\\\)/i;
  if (platformPath.test(value) || forbiddenRoots.some((root) => isAbsolute(root) && value.includes(root))) {
    throw new GitHubBoundaryError("ABSOLUTE_PATH_IN_EXTERNAL_TEXT", `${field} contains a host absolute path.`);
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GitHubBoundaryError("NON_CANONICAL_JSON", "Canonical JSON cannot contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function sha256Json(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

function assertRepositoryPart(value: string, field: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GitHubBoundaryError("INVALID_REPOSITORY", `${field} is not a safe GitHub repository component.`);
  }
}
