# Approval Troubleshooting

ChatGPT host confirmation and server authority are separate controls.

## Allow All Actions

Selecting **Allow all actions** may suppress repeated ChatGPT confirmation for
tools whose annotations match workspace policy. It does not:

- register a repository or enable writes;
- raise repository mode or task authority;
- bypass path, secret, expected HEAD/tree, review, or CI checks;
- expose credential material;
- permit force push or arbitrary GitHub actions; or
- create or replace owner merge approval.

If a tool remains denied after host confirmation, inspect the structured server
error and current policy rather than changing ChatGPT confirmation settings.

## Tool Annotations

Local reads are closed-world read-only tools. Local writes describe whether
they are destructive and idempotent. Remote status, PR, review, CI, merge-gate,
and post-merge reads are open-world read-only. Remote mutations are open-world,
operation-bound, and idempotent at their exact contract boundary.

Annotations help the host describe an action. They are not capabilities and do
not override server checks.

## Push Or Pull Request Is Denied

Confirm all of the following:

1. the base repository was owner-registered in `ship` mode;
2. the task was opened with `ship` authority;
3. `repo_id`, `task_id`, `operation_id`, expected HEAD, and expected tree match;
4. local validation/review and current Git state admit the operation; and
5. installed `gh` authentication and repository permission are valid for
   GitHub calls.

Do not paste `gh auth status` output or tokens into ChatGPT.

## Merge Is Denied

`repo_merge_gate_prepare` must return an eligible, unexpired exact gate. The
owner then runs the command it prints:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

The CLI displays the bound details and writes one mode-0600 approval after
confirmation. `repo_write_merge` rejects a missing, expired, consumed,
mismatched, or state-stale approval. Prepare and inspect a new gate after any
HEAD/tree, PR, review, CI, method, remote-branch-retention, digest, or
expiration change.

## Interrupted Action

Do not assume that an empty response means failure. Keep the original operation
id, call task/status/read-back tools, and inspect durable evidence. Replay only
when the server recognizes the exact operation and reports that replay is safe.
See [Errors And Recovery](ERRORS.md).
