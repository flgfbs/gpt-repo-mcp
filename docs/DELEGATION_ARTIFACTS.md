# Delegation And Semantic Worker Contracts

Delegation is an optional specialist capability for users who operate an
external implementation worker. Chat Pro Repository MCP writes and validates
repository-owned artifacts; it does not launch a model, schedule a provider,
load provider credentials, or control a worker process.

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

## Future Provider-Neutral Semantic Worker Contract

The intended evolution is a provider-neutral **Semantic Worker** protocol. Its
public contract should express repository semantics, not a vendor transport:

| Contract area | Stable provider-neutral content |
| --- | --- |
| Task | task id, goal, exact repository baseline, bounded authority, scope, acceptance criteria |
| Lifecycle | queued/running/awaiting-input/terminal state, timestamps, bounded events |
| Interaction | structured questions, turn/version hash, complete structured replies |
| Result | changed-path evidence, criteria evidence, validation references, terminal outcome |
| Review | exact repository binding, technical findings, product verdict, freshness |
| Lineage | parent/root identity, bounded correction or scope-amendment relationship |

Provider adapter names, model ids, thread ids, credentials, scheduling, retry
policy, and raw logs stay outside the public MCP contract. A future adapter may
translate between a Semantic Worker and these artifacts, but it must not widen
repository authority or bypass validation and review.

Until such contracts are versioned and implemented, the current Delegation v3
schemas remain canonical. “Semantic Worker” in this documentation is a design
direction, not an available embedded execution provider.

## Compatibility Rules

- Treat public tool names, schema fields, artifact versions, hashes, and stale
  behavior as contracts.
- Keep parsing bounded, identity-bound, redacted, and fail-closed.
- Keep worker execution and credentials outside MCP handlers and services.
- Do not reopen private worker artifacts through generic repository reads.
- Require documented migration and contract tests for persisted-format changes.
