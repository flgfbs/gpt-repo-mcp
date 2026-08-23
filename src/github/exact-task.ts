import {
  GitHubBoundaryError,
  assertSha,
  type ExactGitBoundary,
  type GitHubAdapter,
  type LocalGitSnapshot,
  type PullRequestSnapshot,
  type ReviewThread,
  type ServerOwnedTask,
  type TaskLookup
} from "./types.js";

export type ExactTaskInput = {
  operation_id: string;
  repo_id: string;
  task_id: string;
  expected_head_sha: string;
  expected_tree_sha: string;
};

export async function bindExactTask(input: {
  tasks: TaskLookup;
  git: ExactGitBoundary;
  request: ExactTaskInput;
  requireClean: boolean;
}): Promise<{ task: ServerOwnedTask; local: LocalGitSnapshot }> {
  const task = await input.tasks.getServerOwnedTask(input.request.repo_id);
  if (task.repoId !== input.request.repo_id || task.taskId !== input.request.task_id) {
    throw new GitHubBoundaryError("TASK_ID_MISMATCH", "repo_id and task_id do not match the server-owned task.");
  }
  const local = await input.git.inspect(task);
  if (local.branch !== task.branch) {
    throw new GitHubBoundaryError("TASK_BRANCH_DRIFT", "Current branch is not the server-owned task branch.");
  }
  if (local.headSha !== assertSha(input.request.expected_head_sha, "expected head sha")) {
    throw new GitHubBoundaryError("HEAD_DRIFT", "Task HEAD no longer matches expected_head_sha.");
  }
  if (local.treeSha !== assertSha(input.request.expected_tree_sha, "expected tree sha")) {
    throw new GitHubBoundaryError("TREE_DRIFT", "Task tree no longer matches expected_tree_sha.");
  }
  if (input.requireClean && !local.clean) {
    throw new GitHubBoundaryError("WORKTREE_NOT_CLEAN", "Task worktree must be clean before external mutation.");
  }
  return { task, local };
}

export async function assertExactRemoteHead(
  github: GitHubAdapter,
  task: ServerOwnedTask,
  expectedHeadSha: string,
  expectedTreeSha: string
): Promise<void> {
  const remote = await github.getRef(task.repository, `refs/heads/${task.branch}`);
  if (
    remote?.sha !== assertSha(expectedHeadSha, "expected remote head sha")
    || remote.treeSha !== assertSha(expectedTreeSha, "expected remote tree sha")
  ) {
    throw new GitHubBoundaryError("REMOTE_HEAD_MISMATCH", "Remote task branch does not match the exact expected head and tree.");
  }
}

export async function getUniqueTaskPullRequest(input: {
  github: GitHubAdapter;
  task: ServerOwnedTask;
  expectedHeadSha: string;
  requireDraft: boolean;
}): Promise<PullRequestSnapshot> {
  const matches = await input.github.findOpenPullRequests({
    repository: input.task.repository,
    headBranch: input.task.branch,
    baseBranch: input.task.baseBranch
  });
  if (matches.length === 0) throw new GitHubBoundaryError("PR_NOT_FOUND", "No open pull request matches the exact task branch.");
  if (matches.length > 1) throw new GitHubBoundaryError("PR_AMBIGUOUS", "Multiple open pull requests match the exact task branch.");
  const pullRequest = matches[0]!;
  assertExactTaskPullRequest(input.task, pullRequest, input.expectedHeadSha, input.requireDraft);
  return pullRequest;
}

export function assertExactTaskPullRequest(
  task: ServerOwnedTask,
  pullRequest: PullRequestSnapshot,
  expectedHeadSha: string,
  requireDraft: boolean
): void {
  if (pullRequest.state !== "OPEN") throw new GitHubBoundaryError("PR_NOT_OPEN", "Task pull request is not open.");
  if (requireDraft && !pullRequest.isDraft) throw new GitHubBoundaryError("PR_NOT_DRAFT", "Task pull request must remain Draft.");
  if (pullRequest.headRefName !== task.branch || pullRequest.headSha !== expectedHeadSha) {
    throw new GitHubBoundaryError("PR_HEAD_MISMATCH", "Pull request head does not match the exact task branch and head.");
  }
  if (pullRequest.baseRefName !== task.baseBranch) {
    throw new GitHubBoundaryError("PR_BASE_MISMATCH", "Pull request base does not match the task binding.");
  }
}

export async function listAllExactReviewThreads(input: {
  github: GitHubAdapter;
  task: ServerOwnedTask;
  pullRequest: PullRequestSnapshot;
  maxThreads?: number;
}): Promise<ReviewThread[]> {
  const maxThreads = input.maxThreads ?? 500;
  const threads: ReviewThread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (threads.length >= maxThreads) {
      throw new GitHubBoundaryError("REVIEW_THREAD_LIMIT_EXCEEDED", "Review thread evidence exceeds the fixed bound.");
    }
    const page = await input.github.listReviewThreadsPage({
      repository: input.task.repository,
      pullRequestNumber: input.pullRequest.number,
      limit: Math.min(100, maxThreads - threads.length),
      ...(cursor ? { cursor } : {})
    });
    if (
      page.pullRequestId !== input.pullRequest.id
      || page.pullRequestNumber !== input.pullRequest.number
      || page.headSha !== input.pullRequest.headSha
    ) {
      throw new GitHubBoundaryError("REVIEW_HEAD_MISMATCH", "Review threads are not bound to the exact pull request head.");
    }
    for (const thread of page.threads) {
      if (
        thread.pullRequestId !== input.pullRequest.id
        || thread.pullRequestNumber !== input.pullRequest.number
        || thread.headSha !== input.pullRequest.headSha
      ) {
        throw new GitHubBoundaryError("REVIEW_THREAD_BINDING_MISMATCH", "A review thread is not bound to the exact pull request head.");
      }
      threads.push(thread);
      if (threads.length > maxThreads) {
        throw new GitHubBoundaryError("REVIEW_THREAD_LIMIT_EXCEEDED", "Review thread evidence exceeds the fixed bound.");
      }
    }
    cursor = page.nextCursor;
    if (cursor && threads.length >= maxThreads) {
      throw new GitHubBoundaryError("REVIEW_THREAD_LIMIT_EXCEEDED", "Review thread evidence exceeds the fixed bound.");
    }
    if (cursor) {
      if (seenCursors.has(cursor)) throw new GitHubBoundaryError("REVIEW_CURSOR_CYCLE", "GitHub repeated a review pagination cursor.");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return threads;
}
