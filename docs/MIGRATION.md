# Migration Guide

This release changes the public identity, connection path, and tool count while
preserving the inherited 46-tool order.

## Before Updating

1. Stop the local server and Secure MCP Tunnel.
2. Preserve the local configuration and any needed task/artifact state.
3. Update to a trusted revision and run `npm ci` and `npm run build`.
4. Run `npm run check:config` and `npm run doctor`.
5. Refresh the ChatGPT app so it receives the exact 63-tool schema.

## Command And Connection Changes

- The public CLI is `chat-pro-repo`.
- Repository commands are `repo add`, `repo list`, and `repo remove`; package
  shortcuts remain `npm run add`, `npm run list`, and `npm run remove`.
- The local package start uses `CHAT_PRO_REPOSITORY_MCP_CONFIG` and port `8789`.
- ChatGPT connects through OpenAI Secure MCP Tunnel to
  `http://127.0.0.1:8789/mcp`.
- Public-URL connection helpers and their credential/example files are removed.

Do not copy an old public endpoint or connection secret into the new setup.
Activate the Secure MCP Tunnel through the OpenAI workspace.

## Exact Tool Addition

The following 17 names are appended after the inherited 46, in this order:

1. `repo_task_open`
2. `repo_task_status`
3. `repo_task_close`
4. `repo_task_cleanup`
5. `repo_artifact_read`
6. `repo_remote_status`
7. `repo_write_push`
8. `repo_pr_create_or_update`
9. `repo_pr_status`
10. `repo_pr_review_threads`
11. `repo_write_pr_reply`
12. `repo_write_pr_resolve_thread`
13. `repo_ci_status`
14. `repo_write_ci_retry_failed`
15. `repo_merge_gate_prepare`
16. `repo_write_merge`
17. `repo_post_merge_readback`

The total is exactly 63. No old or alternate lifecycle names are accepted as
aliases.

## Local-Only Lifecycle Policy

Lifecycle configuration now has an explicit policy kind:

- `kind: "local"` admits isolated task worktrees and reviewed local Git without
  requiring a remote; and
- `kind: "github"` admits the existing task-bound remote and GitHub lifecycle.

Existing lifecycle entries that omit `kind` are parsed as `kind: "github"`.
Their remote identity, required checks, merge method, task behavior, and public
tool contracts are unchanged, so no configuration rewrite is required. New
local-only entries should be created with:

```bash
npm run add -- /path/to/your/repo --mode ship --local-only
```

The public tool count, names, order, and payload schemas remain exactly 63.
Local-only policy changes admission behavior, not the MCP tool catalog.

## Workflow Change

Push and pull-request work now requires a server-bound task with `ship`
authority and exact expected HEAD/tree. Merge requires a fresh gate and the
owner command printed by `repo_merge_gate_prepare`:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

Old local commits remain ordinary Git history. Existing delegation artifacts
retain their documented versioned compatibility, but new task/GitHub lifecycle
artifacts use opaque ids and must not be treated as paths.

## Rollback

If the updated app cannot be admitted, disable the ChatGPT app and Secure MCP
Tunnel, stop the server, restore the preserved compatible configuration, and
restart the previously trusted revision. Do not reuse a lifecycle operation,
merge gate, or approval across revisions unless the exact runtime reports it as
current and compatible.
