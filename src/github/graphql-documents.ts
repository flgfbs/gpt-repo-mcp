export const REPOSITORY_REF_QUERY = `
query RepositoryRef($owner: String!, $name: String!, $qualifiedName: String!) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    ref(qualifiedName: $qualifiedName) {
      name
      target {
        oid
        ... on Commit { tree { oid } }
      }
    }
  }
}`.trim();

export const REVIEW_THREADS_QUERY = `
query ReviewThreads($owner: String!, $name: String!, $number: Int!, $limit: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      headRefOid
      reviewThreads(first: $limit, after: $cursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first: 100) {
            nodes {
              id
              author { login }
              body
              createdAt
              updatedAt
              url
            }
            pageInfo { hasNextPage }
          }
          pullRequest { id number headRefOid }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`.trim();

export const REPLY_TO_REVIEW_THREAD_MUTATION = `
mutation ReplyToReviewThread($threadId: ID!, $body: String!, $clientMutationId: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body,
    clientMutationId: $clientMutationId
  }) {
    comment {
      id
      author { login }
      body
      createdAt
      updatedAt
      url
    }
    clientMutationId
  }
}`.trim();

export const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation ResolveReviewThread($threadId: ID!, $clientMutationId: String!) {
  resolveReviewThread(input: { threadId: $threadId, clientMutationId: $clientMutationId }) {
    thread {
      id
      isResolved
      isOutdated
      path
      line
      originalLine
      diffSide
      comments(first: 100) {
        nodes {
          id
          author { login }
          body
          createdAt
          updatedAt
          url
        }
        pageInfo { hasNextPage }
      }
      pullRequest { id number headRefOid }
    }
    clientMutationId
  }
}`.trim();

export const MARK_PULL_REQUEST_READY_MUTATION = `
mutation MarkPullRequestReady($pullRequestId: ID!, $clientMutationId: String!) {
  markPullRequestReadyForReview(input: {
    pullRequestId: $pullRequestId,
    clientMutationId: $clientMutationId
  }) {
    pullRequest {
      id
      number
      url
      state
      isDraft
      title
      body
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      mergeable
      mergeStateStatus
      reviewDecision
      updatedAt
      mergedAt
      mergeCommit { oid }
    }
    clientMutationId
  }
}`.trim();
