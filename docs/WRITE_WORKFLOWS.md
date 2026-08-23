# Write And Lifecycle Workflows

This guide separates owner configuration, local repository mutation, task
worktrees, external Git/GitHub effects, and exact owner-approved merge.

## 1. Register Maximum Repository Authority

Registration is owner CLI only:

```bash
npm run add -- /path/to/your/repo --mode <mode>
```

Use explicit `read`, `write`, or `ship`. No MCP tool can add a root or raise its
mode. Manual config remains supported for advanced operators, but CLI
registration is preferred because it canonicalizes and validates the root.

## 2. Inspect Before Mutation

Use `repo_list_roots`, `repo_policy_explain`, `repo_project_brief`, tree/search
reads, and `repo_git_status` to bind the repository and current state. Read only
the files and diffs needed for the task.

For a simple local edit, the normal path is:

```text
inspect -> repo_write_file/repo_write_changes -> repo_validate
        -> repo_git_review/repo_ship_review
        -> exact local commit or exact recovery
```

Direct write tools never run Git. Git tools never accept a shell command.

## 3. Open An Isolated Task

Use `repo_task_open` when work needs an isolated branch/worktree or any GitHub
lifecycle operation. Bind:

- `operation_id` and `task_id`;
- base `repo_id`, branch, commit SHA, and tree SHA;
- task authority: `inspect`, `implement`, or `ship`;
- the exact goal; and
- a lowercase branch slug.

The server derives the task repository id, branch, and worktree. An exact replay
of the same operation is idempotent. A conflicting replay fails.

Use `repo_task_status` to resume. It returns the bound base, current exact
HEAD/tree, task state, lifecycle artifacts, and cleanup eligibility. The public
artifact window is capped at 200 references; `ARTIFACTS_TRUNCATED` means
additional durable artifacts remain available by their opaque ids.

## 4. Implement, Validate, And Review

Within `implement` or `ship` authority:

1. inspect current task state;
2. edit only allowed repo-relative paths;
3. run `repo_validate` with a named profile;
4. inspect `repo_git_diff` and `repo_git_review`;
5. use `repo_semantic_review` for focused semantic risk;
6. use `repo_ship_review` before committing or making external contact; and
7. stage and commit only the exact reviewed pathset at the expected HEAD.

Validation output may be returned directly when small or as a `validation_log`
artifact. A large diff can become a `large_diff` artifact. Artifact ids are
opaque and cannot be converted into source paths by a caller. Full validation
captures redact host absolute paths before the task artifact can be served.

## 5. Observe And Push

GitHub contact and push require a task-bound `operation_id`, `repo_id`,
`task_id`, expected HEAD, and expected tree. Push and pull-request mutation also
require `ship` authority.

1. Call `repo_remote_status` to record the exact remote relationship.
2. Call `repo_write_push` for the exact server-owned task branch.
3. Inspect the returned pre/post contact state and remote read-back.

The push boundary uses a fixed argument vector, never force, and never accepts a
caller-selected branch or remote. Its durable effect state is `no_change`,
`pushed`, or `queryable_effect`.

If the response is interrupted, do not repeat with a new operation id. Resume
with the same task and inspect its receipt/remote state so the original effect
can be classified.

## 6. Create Or Update The Draft Pull Request

Call `repo_pr_create_or_update` with the exact task state, title, body, and the
required literal Draft setting. The server derives repository, base branch, and
head branch from the task. It cannot create a non-Draft pull request.

Use `repo_pr_status` to read current PR state. A changed local HEAD/tree makes
previous state-bound evidence stale and requires a new observation/push.

## 7. Handle Review

1. Read bounded threads with `repo_pr_review_threads`.
2. Correct the task worktree and repeat local validation/review, or preserve the
   exact HEAD when the thread only requests confirmation of already-final code.
3. Push the new exact HEAD when code changed.
4. Reply with `repo_write_pr_reply` when a response is appropriate.
5. Resolve with `repo_write_pr_resolve_thread` only at the exact observed thread
   update time. The server requires either a prior snapshot followed by a new
   corrected HEAD, or a prior same-HEAD snapshot, an exact durable reply present
   in the current thread, and fresh exact validation completed after that reply.

Replies and resolutions use operation replay protection. Thread ids come from
the bound pull request, not arbitrary caller-selected PR coordinates. A reply
alone never authorizes resolution, and an unresolved unknown external effect
blocks both evidence paths.

## 8. Handle CI

`repo_ci_status` returns runs and checks for the exact task HEAD plus an opaque
`ci_status_id`. If failed runs are safely retryable, pass only their exact run
ids and that snapshot id to `repo_write_ci_retry_failed`.

The retry tool cannot start an arbitrary workflow, choose another ref, or rerun
successful/unknown runs. Retry admission is serialized by exact task, HEAD, and
run id, so concurrent operation ids cannot consume the same permitted retry.
A code correction creates a new HEAD and requires new validation, push, PR,
review, CI, and merge-gate evidence.

## 9. Prepare And Approve The Exact Merge Gate

Call `repo_merge_gate_prepare` with the expected task HEAD/tree. The server
binds the configured merge method (`merge`, `squash`, or `rebase`) and mandatory
remote task-branch retention. It is read-only and returns blockers or an
expiring manifest.

When eligible, it prints exactly:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

The owner runs that command in a terminal. The CLI resolves the
content-addressed gate, displays its exact repository/task/PR/HEAD/tree/method/
CI/review/expiry binding, asks for confirmation, and writes one mode-0600
approval.

Merge requires one exact, unexpired, one-time owner approval.

ChatGPT cannot mint this approval. **Allow all actions** does not substitute for
it.

## 10. Merge And Read Back

`repo_write_merge` receives the original operation/task state plus manifest id,
manifest digest, and owner approval id. It revalidates the unexpired exact
binding and consumes the approval once. Its effect is `merged` or a verified
`already_merged` result for the same binding.

Always finish with `repo_post_merge_readback`. It confirms the PR, merged head,
merge commit, base ref, task ref, and task-branch retention. An incomplete
read-back is reported as incomplete, not silently upgraded to success.

## 11. Close And Clean The Task

Close at the exact final HEAD/tree with one outcome:

- `completed`
- `blocked`
- `abandoned`
- `superseded`

`repo_task_cleanup` is separately explicit and eligible only after close. Its
scope is `workspace_only` or `workspace_and_artifacts`. Cleanup deletes only
server-owned task resources and retains a durable cleanup receipt.

## Crash And Recovery Rules

After any interruption:

1. preserve the original `operation_id` and arguments;
2. call `repo_task_status` and the relevant local/remote read tool;
3. inspect durable receipts or opaque evidence;
4. classify the effect as absent, confirmed, or still queryable/uncertain; and
5. retry only when the returned state explicitly admits an idempotent replay.

At server startup, an OPEN task whose configured base or worktree is not
byte-exact is durably marked `RECOVERY_REQUIRED` and omitted from active task
registration; other repositories still start. Use
`chat-pro-repo task inspect <task_id>` to inspect the durable binding, repair the
owner configuration or worktree outside the server, and restart. An exact
repaired binding rehydrates to OPEN; no Git mutation is replayed automatically.

Never infer failure from an empty response, mint a replacement operation id to
bypass replay detection, or reuse a merge approval after any bound state
changes.

## Out Of Scope

`ship` means authority for reviewed local Git plus the documented task-bound
push, Draft PR, CI/review, and exact merge path. It does not authorize release,
deployment, signing, package publication, environment mutation, or
infrastructure change.
