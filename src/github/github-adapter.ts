import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  MARK_PULL_REQUEST_READY_MUTATION,
  REPLY_TO_REVIEW_THREAD_MUTATION,
  REPOSITORY_REF_QUERY,
  RESOLVE_REVIEW_THREAD_MUTATION,
  REVIEW_THREADS_QUERY
} from "./graphql-documents.js";
import type { GhJsonRunner, GhRunResult } from "./gh-json-runner.js";
import {
  GitHubBoundaryError,
  assertSafeBranch,
  assertSafeExternalText,
  assertSha,
  repositorySlug,
  sha256,
  type CheckRunPage,
  type CommitStatusPage,
  type CompareSnapshot,
  type GitHubAdapter,
  type GitHubRefSnapshot,
  type GitHubRepositoryRef,
  type JsonValue,
  type MergeApiResult,
  type PullRequestSnapshot,
  type RepositorySnapshot,
  type ReviewComment,
  type ReviewReplyReceipt,
  type ReviewThread,
  type ReviewThreadPage,
  type WorkflowRun
} from "./types.js";

const PR_JSON_FIELDS = [
  "id",
  "number",
  "url",
  "state",
  "isDraft",
  "title",
  "body",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "baseRefOid",
  "mergeable",
  "mergeStateStatus",
  "reviewDecision",
  "mergedAt",
  "mergeCommit",
  "updatedAt"
].join(",");

const HighLevelPullRequestSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  title: z.string(),
  body: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
  updatedAt: z.string().datetime()
});

const RestPullRequestSchema = z.object({
  node_id: z.string().min(1),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  merged: z.boolean().default(false),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  updated_at: z.string().datetime(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().default("unknown"),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() })
});

const RepositorySchema = z.object({
  id: z.string().min(1),
  nameWithOwner: z.string().min(3),
  defaultBranchRef: z.object({ name: z.string().min(1) }),
  isArchived: z.boolean(),
  viewerPermission: z.string(),
  mergeCommitAllowed: z.boolean(),
  rebaseMergeAllowed: z.boolean(),
  squashMergeAllowed: z.boolean()
});

const CheckRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    head_sha: z.string(),
    status: z.enum(["queued", "in_progress", "completed", "waiting", "pending", "requested"]),
    conclusion: z.string().nullable().optional(),
    app: z.object({ slug: z.string().nullable() }).nullable()
  }))
});

const CommitStatusesSchema = z.object({
  sha: z.string(),
  state: z.enum(["error", "failure", "pending", "success"]),
  statuses: z.array(z.object({
    id: z.number().int().nonnegative(),
    context: z.string(),
    state: z.enum(["error", "failure", "pending", "success"])
  }))
});

const WorkflowRunListSchema = z.array(z.object({
  databaseId: z.number().int().positive(),
  headSha: z.string(),
  attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  workflowName: z.string()
}));

const WorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string(),
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  name: z.string()
});

const MergeResultSchema = z.object({
  merged: z.boolean(),
  message: z.string(),
  sha: z.string().nullable().optional()
});

const CompareSchema = z.object({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  merge_base_commit: z.object({ sha: z.string() })
});

const ReviewCommentSchema = z.object({
  id: z.string().min(1),
  author: z.object({ login: z.string().min(1) }).nullable(),
  body: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  url: z.string().url()
});

const ReviewThreadSchema = z.object({
  id: z.string().min(1),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().positive().nullable().optional(),
  originalLine: z.number().int().positive().nullable().optional(),
  diffSide: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  comments: z.object({
    nodes: z.array(ReviewCommentSchema.nullable()),
    pageInfo: z.object({ hasNextPage: z.boolean() })
  }),
  pullRequest: z.object({ id: z.string(), number: z.number().int().positive(), headRefOid: z.string() })
});

export class ProductionGitHubAdapter implements GitHubAdapter {
  constructor(private readonly runner: GhJsonRunner) {}

  async getRepository(repository: GitHubRepositoryRef): Promise<RepositorySnapshot> {
    const parsed = parseResponse(RepositorySchema, await this.callJson([
      "repo", "view", fullyQualifiedRepository(repository),
      "--json", "id,nameWithOwner,defaultBranchRef,isArchived,viewerPermission,mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed"
    ], undefined, false), false);
    return {
      id: parsed.id,
      nameWithOwner: parsed.nameWithOwner,
      defaultBranch: parsed.defaultBranchRef.name,
      archived: parsed.isArchived,
      viewerPermission: parsed.viewerPermission,
      mergeMethods: {
        merge: parsed.mergeCommitAllowed,
        rebase: parsed.rebaseMergeAllowed,
        squash: parsed.squashMergeAllowed
      }
    };
  }

  async getRef(repository: GitHubRepositoryRef, qualifiedName: string): Promise<GitHubRefSnapshot | undefined> {
    if (!qualifiedName.startsWith("refs/heads/")) {
      throw new GitHubBoundaryError("INVALID_REF", "Only refs/heads GitHub refs are supported.");
    }
    const data = parseGraphqlData(z.object({
      repository: z.object({
        id: z.string(),
        nameWithOwner: z.string(),
        ref: z.object({
          name: z.string(),
          target: z.object({ oid: z.string(), tree: z.object({ oid: z.string() }) })
        }).nullable()
      }).nullable()
    }), await this.callGraphql({
      query: REPOSITORY_REF_QUERY,
      variables: {
        owner: repository.owner,
        name: repository.name,
        qualifiedName
      }
    }, false), false);
    const ref = data.repository?.ref;
    if (!ref) return undefined;
    return {
      qualifiedName,
      sha: assertSha(ref.target.oid, "ref target sha"),
      treeSha: assertSha(ref.target.tree.oid, "ref tree sha")
    };
  }

  async findOpenPullRequests(input: {
    repository: GitHubRepositoryRef;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot[]> {
    assertSafeBranch(input.headBranch);
    assertSafeBranch(input.baseBranch);
    const parsed = parseResponse(z.array(HighLevelPullRequestSchema), await this.callJson([
      "pr", "list",
      "--repo", fullyQualifiedRepository(input.repository),
      "--state", "open",
      "--head", input.headBranch,
      "--base", input.baseBranch,
      "--limit", "2",
      "--json", PR_JSON_FIELDS
    ], undefined, false), false);
    return parsed.map(fromHighLevelPullRequest);
  }

  async getPullRequest(repository: GitHubRepositoryRef, number: number): Promise<PullRequestSnapshot> {
    assertPositiveInteger(number, "pull request number");
    const parsed = parseResponse(HighLevelPullRequestSchema, await this.callJson([
      "pr", "view", String(number),
      "--repo", fullyQualifiedRepository(repository),
      "--json", PR_JSON_FIELDS
    ], undefined, false), false);
    return fromHighLevelPullRequest(parsed);
  }

  async createDraftPullRequest(input: {
    repository: GitHubRepositoryRef;
    title: string;
    body: string;
    headBranch: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot> {
    assertSafeExternalText(input.title, "pull request title");
    assertSafeExternalText(input.body, "pull request body");
    assertSafeBranch(input.headBranch);
    assertSafeBranch(input.baseBranch);
    const parsed = parseResponse(RestPullRequestSchema, await this.callJson(apiArgs(
      "POST", `repos/${repositorySlug(input.repository)}/pulls`, true
    ), {
      title: input.title,
      body: input.body,
      head: `${input.repository.owner}:${input.headBranch}`,
      base: input.baseBranch,
      draft: true,
      maintainer_can_modify: false
    }, true), true);
    return fromRestPullRequest(parsed);
  }

  async updatePullRequest(input: {
    repository: GitHubRepositoryRef;
    number: number;
    title: string;
    body: string;
    baseBranch: string;
  }): Promise<PullRequestSnapshot> {
    assertPositiveInteger(input.number, "pull request number");
    assertSafeExternalText(input.title, "pull request title");
    assertSafeExternalText(input.body, "pull request body");
    assertSafeBranch(input.baseBranch);
    const parsed = parseResponse(RestPullRequestSchema, await this.callJson(apiArgs(
      "PATCH", `repos/${repositorySlug(input.repository)}/pulls/${input.number}`, true
    ), {
      title: input.title,
      body: input.body,
      base: input.baseBranch
    }, true), true);
    return fromRestPullRequest(parsed);
  }

  async markPullRequestReady(repository: GitHubRepositoryRef, pullRequestId: string): Promise<PullRequestSnapshot> {
    repositorySlug(repository);
    assertNodeId(pullRequestId, "pull request id");
    const data = parseGraphqlData(z.object({
      markPullRequestReadyForReview: z.object({
        pullRequest: HighLevelPullRequestSchema,
        clientMutationId: z.string().nullable().optional()
      }).nullable()
    }), await this.callGraphql({
      query: MARK_PULL_REQUEST_READY_MUTATION,
      variables: {
        pullRequestId,
        clientMutationId: `ready:${pullRequestId}`
      }
    }, true), true);
    const pullRequest = data.markPullRequestReadyForReview?.pullRequest;
    if (!pullRequest) {
      throw new GitHubBoundaryError("READY_RESPONSE_MISSING", "GitHub did not return the marked-ready pull request.", "UNKNOWN");
    }
    return fromHighLevelPullRequest(pullRequest);
  }

  async listReviewThreadsPage(input: {
    repository: GitHubRepositoryRef;
    pullRequestNumber: number;
    limit: number;
    cursor?: string;
  }): Promise<ReviewThreadPage> {
    assertPositiveInteger(input.pullRequestNumber, "pull request number");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new GitHubBoundaryError("INVALID_REVIEW_LIMIT", "Review thread limit must be between 1 and 100.");
    }
    if (input.cursor && (input.cursor.length > 500 || input.cursor.includes("\0"))) {
      throw new GitHubBoundaryError("INVALID_CURSOR", "Review thread cursor is invalid.");
    }
    const data = parseGraphqlData(z.object({
      repository: z.object({
        pullRequest: z.object({
          id: z.string(),
          number: z.number().int().positive(),
          headRefOid: z.string(),
          reviewThreads: z.object({
            nodes: z.array(ReviewThreadSchema.nullable()),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
          })
        }).nullable()
      }).nullable()
    }), await this.callGraphql({
      query: REVIEW_THREADS_QUERY,
      variables: {
        owner: input.repository.owner,
        name: input.repository.name,
        number: input.pullRequestNumber,
        limit: input.limit,
        cursor: input.cursor ?? null
      }
    }, false), false);
    const pr = data.repository?.pullRequest;
    if (!pr) throw new GitHubBoundaryError("PR_NOT_FOUND", "Pull request was not found.");
    const threads = pr.reviewThreads.nodes.filter((value): value is z.infer<typeof ReviewThreadSchema> => value !== null).map(fromReviewThread);
    return {
      pullRequestId: pr.id,
      pullRequestNumber: pr.number,
      headSha: assertSha(pr.headRefOid, "review thread head sha"),
      threads,
      ...(pr.reviewThreads.pageInfo.hasNextPage && pr.reviewThreads.pageInfo.endCursor
        ? { nextCursor: pr.reviewThreads.pageInfo.endCursor }
        : {})
    };
  }

  async replyToReviewThread(input: {
    repository: GitHubRepositoryRef;
    threadId: string;
    body: string;
    operationMarker: string;
  }): Promise<ReviewReplyReceipt> {
    assertNodeId(input.threadId, "review thread id");
    assertNodeId(input.operationMarker, "operation marker");
    assertSafeExternalText(input.body, "review reply");
    const data = parseGraphqlData(z.object({
      addPullRequestReviewThreadReply: z.object({
        comment: ReviewCommentSchema,
        clientMutationId: z.string().nullable().optional()
      }).nullable()
    }), await this.callGraphql({
      query: REPLY_TO_REVIEW_THREAD_MUTATION,
      variables: {
        threadId: input.threadId,
        body: input.body,
        clientMutationId: input.operationMarker
      }
    }, true), true);
    const comment = data.addPullRequestReviewThreadReply?.comment;
    if (!comment) throw new GitHubBoundaryError("REPLY_RESPONSE_MISSING", "GitHub did not return the review reply.", "UNKNOWN");
    return { comment: fromReviewComment(comment), threadId: input.threadId, operationMarker: input.operationMarker };
  }

  async resolveReviewThread(input: {
    repository: GitHubRepositoryRef;
    threadId: string;
  }): Promise<ReviewThread> {
    assertNodeId(input.threadId, "review thread id");
    const data = parseGraphqlData(z.object({
      resolveReviewThread: z.object({
        thread: ReviewThreadSchema,
        clientMutationId: z.string().nullable().optional()
      }).nullable()
    }), await this.callGraphql({
      query: RESOLVE_REVIEW_THREAD_MUTATION,
      variables: {
        threadId: input.threadId,
        clientMutationId: `resolve:${input.threadId}`
      }
    }, true), true);
    const thread = data.resolveReviewThread?.thread;
    if (!thread) throw new GitHubBoundaryError("RESOLVE_RESPONSE_MISSING", "GitHub did not return the resolved review thread.", "UNKNOWN");
    return fromReviewThread(thread);
  }

  async getCheckRunsPage(input: {
    repository: GitHubRepositoryRef;
    sha: string;
    page: number;
  }): Promise<CheckRunPage> {
    assertSha(input.sha);
    assertPage(input.page);
    const parsed = parseResponse(CheckRunsSchema, await this.callJson(apiArgs(
      "GET",
      `repos/${repositorySlug(input.repository)}/commits/${input.sha}/check-runs?filter=latest&per_page=100&page=${input.page}`,
      false
    ), undefined, false), false);
    return {
      totalCount: parsed.total_count,
      checkRuns: parsed.check_runs.map((check) => ({
        id: check.id,
        name: check.name,
        appSlug: check.app?.slug ?? "unknown",
        headSha: assertSha(check.head_sha, "check run head sha"),
        status: check.status,
        ...(check.conclusion ? { conclusion: check.conclusion } : {})
      }))
    };
  }

  async getCommitStatusesPage(input: {
    repository: GitHubRepositoryRef;
    sha: string;
    page: number;
  }): Promise<CommitStatusPage> {
    assertSha(input.sha);
    assertPage(input.page);
    const parsed = parseResponse(CommitStatusesSchema, await this.callJson(apiArgs(
      "GET",
      `repos/${repositorySlug(input.repository)}/commits/${input.sha}/status?per_page=100&page=${input.page}`,
      false
    ), undefined, false), false);
    return {
      sha: assertSha(parsed.sha, "combined status sha"),
      state: parsed.state,
      statuses: parsed.statuses
    };
  }

  async listWorkflowRunsForCommit(repository: GitHubRepositoryRef, sha: string): Promise<WorkflowRun[]> {
    assertSha(sha);
    const parsed = parseResponse(WorkflowRunListSchema, await this.callJson([
      "run", "list",
      "--repo", fullyQualifiedRepository(repository),
      "--commit", sha,
      "--limit", "100",
      "--json", "attempt,conclusion,databaseId,headSha,status,workflowName"
    ], undefined, false), false);
    return parsed.map((run) => ({
      id: run.databaseId,
      headSha: assertSha(run.headSha, "workflow run head sha"),
      attempt: run.attempt,
      status: run.status,
      ...(run.conclusion ? { conclusion: run.conclusion } : {}),
      workflowName: run.workflowName
    }));
  }

  async getWorkflowRun(repository: GitHubRepositoryRef, runId: number): Promise<WorkflowRun> {
    assertPositiveInteger(runId, "workflow run id");
    const parsed = parseResponse(WorkflowRunSchema, await this.callJson(apiArgs(
      "GET", `repos/${repositorySlug(repository)}/actions/runs/${runId}`, false
    ), undefined, false), false);
    return {
      id: parsed.id,
      headSha: assertSha(parsed.head_sha, "workflow run head sha"),
      attempt: parsed.run_attempt,
      status: parsed.status,
      ...(parsed.conclusion ? { conclusion: parsed.conclusion } : {}),
      workflowName: parsed.name
    };
  }

  async retryFailedJobs(repository: GitHubRepositoryRef, runId: number): Promise<void> {
    assertPositiveInteger(runId, "workflow run id");
    await this.callEmpty(apiArgs(
      "POST", `repos/${repositorySlug(repository)}/actions/runs/${runId}/rerun-failed-jobs`, true
    ), {}, true);
  }

  async mergePullRequest(input: {
    repository: GitHubRepositoryRef;
    number: number;
    expectedHeadSha: string;
    method: "merge" | "squash" | "rebase";
  }): Promise<MergeApiResult> {
    assertPositiveInteger(input.number, "pull request number");
    assertSha(input.expectedHeadSha, "expected merge head sha");
    const parsed = parseResponse(MergeResultSchema, await this.callJson(apiArgs(
      "PUT", `repos/${repositorySlug(input.repository)}/pulls/${input.number}/merge`, true
    ), {
      sha: input.expectedHeadSha,
      merge_method: input.method
    }, true), true);
    return {
      merged: parsed.merged,
      message: parsed.merged ? "MERGED" : "NOT_MERGED",
      ...(parsed.sha ? { sha: assertSha(parsed.sha, "merge result sha") } : {})
    };
  }

  async compare(repository: GitHubRepositoryRef, baseSha: string, headSha: string): Promise<CompareSnapshot> {
    assertSha(baseSha, "compare base sha");
    assertSha(headSha, "compare head sha");
    const parsed = parseResponse(CompareSchema, await this.callJson(apiArgs(
      "GET", `repos/${repositorySlug(repository)}/compare/${baseSha}...${headSha}`, false
    ), undefined, false), false);
    return {
      status: parsed.status,
      aheadBy: parsed.ahead_by,
      behindBy: parsed.behind_by,
      mergeBaseSha: assertSha(parsed.merge_base_commit.sha, "merge base sha")
    };
  }

  private async callGraphql(body: JsonValue, write: boolean): Promise<unknown> {
    return await this.callJson([
      "api", "graphql",
      "--hostname", "github.com",
      "--method", "POST",
      "--input", "-"
    ], body, write);
  }

  private async callJson(args: readonly string[], stdinJson: JsonValue | undefined, write: boolean): Promise<unknown> {
    const result = await this.runner.run({ args, ...(stdinJson === undefined ? {} : { stdinJson }) });
    assertSuccessfulResult(result, write);
    const output = result.stdout.trim();
    if (!output) {
      throw new GitHubBoundaryError("GH_JSON_MISSING", "gh returned no JSON response.", write ? "UNKNOWN" : "NONE");
    }
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new GitHubBoundaryError("GH_JSON_INVALID", "gh returned invalid JSON.", write ? "UNKNOWN" : "NONE");
    }
  }

  private async callEmpty(args: readonly string[], stdinJson: JsonValue, write: boolean): Promise<void> {
    const result = await this.runner.run({ args, stdinJson });
    assertSuccessfulResult(result, write);
    if (result.stdout.trim() !== "") {
      throw new GitHubBoundaryError("GH_EMPTY_RESPONSE_INVALID", "gh returned unexpected output for a no-content response.", "UNKNOWN");
    }
  }
}

function apiArgs(method: "GET" | "POST" | "PATCH" | "PUT", endpoint: string, input: boolean): string[] {
  return [
    "api",
    "--hostname", "github.com",
    "--method", method,
    ...(input ? ["--input", "-"] : []),
    endpoint
  ];
}

function fullyQualifiedRepository(repository: GitHubRepositoryRef): string {
  return `github.com/${repositorySlug(repository)}`;
}

function fromHighLevelPullRequest(value: z.infer<typeof HighLevelPullRequestSchema>): PullRequestSnapshot {
  return {
    id: value.id,
    number: value.number,
    url: assertPullRequestUrl(value.url, value.number),
    state: value.state,
    isDraft: value.isDraft,
    title: assertSafeExternalText(value.title, "pull request title"),
    headRefName: assertSafeBranch(value.headRefName),
    headSha: assertSha(value.headRefOid, "pull request head sha"),
    baseRefName: assertSafeBranch(value.baseRefName),
    baseSha: assertSha(value.baseRefOid, "pull request base sha"),
    titleDigest: sha256(value.title),
    bodyDigest: sha256(value.body),
    operationMarkers: operationMarkers(value.body),
    mergeable: value.mergeable,
    mergeStateStatus: value.mergeStateStatus,
    updatedAt: value.updatedAt,
    ...(value.reviewDecision ? { reviewDecision: value.reviewDecision } : {}),
    ...(value.mergedAt ? { mergedAt: value.mergedAt } : {}),
    ...(value.mergeCommit?.oid ? { mergeCommitSha: assertSha(value.mergeCommit.oid, "merge commit sha") } : {})
  };
}

function fromRestPullRequest(value: z.infer<typeof RestPullRequestSchema>): PullRequestSnapshot {
  const body = value.body ?? "";
  return {
    id: value.node_id,
    number: value.number,
    url: assertPullRequestUrl(value.html_url, value.number),
    state: value.merged ? "MERGED" : value.state === "open" ? "OPEN" : "CLOSED",
    isDraft: value.draft,
    title: assertSafeExternalText(value.title, "pull request title"),
    headRefName: assertSafeBranch(value.head.ref),
    headSha: assertSha(value.head.sha, "pull request head sha"),
    baseRefName: assertSafeBranch(value.base.ref),
    baseSha: assertSha(value.base.sha, "pull request base sha"),
    titleDigest: sha256(value.title),
    bodyDigest: sha256(body),
    operationMarkers: operationMarkers(body),
    mergeable: value.mergeable === true ? "MERGEABLE" : value.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    mergeStateStatus: value.mergeable_state.toUpperCase(),
    updatedAt: value.updated_at,
    ...(value.merged_at ? { mergedAt: value.merged_at } : {}),
    ...(value.merge_commit_sha ? { mergeCommitSha: assertSha(value.merge_commit_sha, "merge commit sha") } : {})
  };
}

function fromReviewThread(value: z.infer<typeof ReviewThreadSchema>): ReviewThread {
  if (isAbsolute(value.path) || value.path.includes("\\") || value.path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new GitHubBoundaryError("UNSAFE_REVIEW_PATH", "GitHub returned an unsafe review thread path.");
  }
  if (value.comments.pageInfo.hasNextPage) {
    throw new GitHubBoundaryError("REVIEW_COMMENTS_TRUNCATED", "A review thread has more than the fixed 100-comment bound.");
  }
  const comments = value.comments.nodes
    .filter((comment): comment is z.infer<typeof ReviewCommentSchema> => comment !== null)
    .map(fromReviewComment);
  if (comments.length === 0) {
    throw new GitHubBoundaryError("REVIEW_THREAD_EMPTY", "GitHub returned a review thread without comments.");
  }
  const updatedAt = comments.reduce(
    (latest, comment) => comment.updatedAt > latest ? comment.updatedAt : latest,
    "1970-01-01T00:00:00.000Z"
  );
  return {
    id: value.id,
    pullRequestId: value.pullRequest.id,
    pullRequestNumber: value.pullRequest.number,
    headSha: assertSha(value.pullRequest.headRefOid, "review thread head sha"),
    isResolved: value.isResolved,
    isOutdated: value.isOutdated,
    path: value.path,
    ...(value.line ? { line: value.line } : {}),
    ...(value.originalLine ? { originalLine: value.originalLine } : {}),
    ...(value.diffSide ? { side: value.diffSide } : {}),
    comments,
    updatedAt
  };
}

function fromReviewComment(value: z.infer<typeof ReviewCommentSchema>): ReviewComment {
  const author = value.author?.login ?? "ghost";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(author) && author !== "ghost") {
    throw new GitHubBoundaryError("UNSAFE_REVIEW_AUTHOR", "GitHub returned an unsafe review author.");
  }
  return {
    id: value.id,
    author,
    body: assertSafeExternalText(value.body, "review comment body"),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    url: assertGitHubUrl(value.url, "review comment URL")
  };
}

function operationMarkers(body: string): string[] {
  return [...body.matchAll(/<!-- chat-pro-operation:([A-Za-z0-9][A-Za-z0-9._:-]{0,199}) -->/g)]
    .map((match) => match[1]!)
    .sort();
}

function parseGraphqlData<T>(schema: z.ZodType<T>, value: unknown, write: boolean): T {
  const envelope = parseResponse(z.object({
    data: z.unknown().nullable().optional(),
    errors: z.array(z.unknown()).optional()
  }), value, write);
  if ((envelope.errors?.length ?? 0) > 0 || envelope.data === null || envelope.data === undefined) {
    throw new GitHubBoundaryError("GITHUB_GRAPHQL_ERROR", "GitHub GraphQL returned an error response.", write ? "UNKNOWN" : "NONE");
  }
  return parseResponse(schema, envelope.data, write);
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown, write: boolean): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GitHubBoundaryError("GH_RESPONSE_SCHEMA_INVALID", "gh returned JSON outside the fixed response schema.", write ? "UNKNOWN" : "NONE");
  }
  return parsed.data;
}

function assertSuccessfulResult(result: GhRunResult, write: boolean): void {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new GitHubBoundaryError("GH_OUTPUT_TRUNCATED", "gh output exceeded the fixed response limit.", write && result.spawned ? "UNKNOWN" : "NONE");
  }
  if (result.exitCode === 0 && !result.timedOut) return;
  const httpStatus = httpStatusFromStderr(result.stderr);
  const transient = result.timedOut || httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 502 && httpStatus <= 504);
  const knownHttpFailure = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
  const effect = write && result.spawned ? (knownHttpFailure ? "KNOWN" : "UNKNOWN") : "NONE";
  throw new GitHubBoundaryError(
    transient ? "GH_TRANSIENT_FAILURE" : "GH_COMMAND_FAILED",
    "gh command failed without exposing command output.",
    effect,
    transient
  );
}

function httpStatusFromStderr(stderr: string): number | undefined {
  const match = stderr.match(/\(HTTP ([1-5][0-9]{2})\)/);
  return match ? Number(match[1]) : undefined;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GitHubBoundaryError("INVALID_NUMBER", `${field} must be a positive safe integer.`);
  }
}

function assertPage(page: number): void {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) {
    throw new GitHubBoundaryError("INVALID_PAGE", "GitHub page must be between 1 and 100.");
  }
}

function assertNodeId(value: string, field: string): void {
  if (!/^[A-Za-z0-9_=:.-]{1,500}$/.test(value)) {
    throw new GitHubBoundaryError("INVALID_NODE_ID", `${field} is invalid.`);
  }
}

function assertPullRequestUrl(value: string, number: number): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubBoundaryError("INVALID_PR_URL", "GitHub returned an invalid pull request URL.");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !parsed.pathname.endsWith(`/pull/${number}`)
  ) {
    throw new GitHubBoundaryError("INVALID_PR_URL", "GitHub returned a non-canonical pull request URL.");
  }
  return parsed.toString();
}

function assertGitHubUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitHubBoundaryError("INVALID_GITHUB_URL", `${field} is invalid.`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw new GitHubBoundaryError("INVALID_GITHUB_URL", `${field} is not a canonical GitHub URL.`);
  }
  return parsed.toString();
}
