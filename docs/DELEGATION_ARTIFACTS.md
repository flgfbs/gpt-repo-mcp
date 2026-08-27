# Delegation And Semantic Worker Contracts

Delegation is an optional specialist capability for users who operate an
external implementation worker. Chat Pro Repository MCP writes and validates
repository-owned artifacts. Its default MCP server does not select a provider,
load provider credentials, or automatically start a worker or queue consumer.

## Current Delegation V3

The current public names retain `codex` for compatibility:

1. `repo_prepare_codex_task` previews a bound task.
2. `repo_write_codex_task` writes the task artifacts.
3. An external worker writes strict result evidence.
4. `repo_agent_runs` exposes bounded lifecycle and structured questions.
5. `repo_write_agent_reply` writes an exact current reply artifact.
6. `repo_codex_review` verifies task, repository, scope, Git, and evidence.
7. `repo_write_codex_review` records the state-bound qualitative verdict.
8. Normal validation, ship review, local commit, and task lifecycle remain
   authoritative.

Artifacts live under local `.chatgpt/` state and are not intended for commit or
publication. Generic tree, file, and search tools exclude private run state.
The dedicated run tool returns only bounded, schema-validated, redacted fields.

## Evidence Is Not Authority

A worker result cannot approve its own scope, product claim, validation, push,
pull request, merge, release, or deployment. Review binds exact repository
state. A relevant HEAD or byte change makes prior evidence stale. Malformed,
unsafe, oversized, mismatched, or secret-bearing artifacts fail closed.

Several related runs may share a dirty worktree only through the explicit
integration-review contract. The server binds the reviewed run set, current
HEAD, path union, content fingerprint, validation, verdicts, and commit payload.

## Provider-Neutral Execution Runtime

The execution substrate expresses repository semantics rather than vendor
transport:

| Contract area | Stable provider-neutral content |
| --- | --- |
| Task admission | absent, sole exact matching active task, or conflicting active task |
| Dispatch | immutable task, Delegation v3, supervisor, runtime, and digest binding |
| Launch | one immutable launch intent with ordinal one |
| Supervisor | typed service identity, queue-consumer state, health, and provider-contact attestation |
| Result | immutable bounded outcome with `replay_allowed: false` |
| Recovery | launch intent without result and unknown effects stop without replay |

`repo_task_admission` is the only new public surface. The queue consumer,
dispatch store, and launcher interface are internal runtime components. They are
not a second MCP server, scheduler, or control plane, and default server
construction does not start them. Provider-free qualification injects a
deterministic launcher and proves one launch per admitted dispatch without model
contact.

Provider adapter names, model ids, private thread ids, credentials, commands,
retry controls, and raw logs stay outside public MCP inputs. A live adapter must
be separately constructed under current authority and cannot widen repository
scope or bypass validation and review.

## Compatibility Rules

- Treat public tool names, schema fields, artifact versions, hashes, and stale
  behavior as contracts.
- Keep parsing bounded, identity-bound, redacted, and fail-closed.
- Keep provider execution and credentials outside MCP handlers and default server construction.
- Do not reopen private worker artifacts through generic repository reads.
- Require documented migration and contract tests for persisted-format changes.
