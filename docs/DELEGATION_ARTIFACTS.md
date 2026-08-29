# Delegation And Semantic Worker Contracts

Delegation is an optional specialist capability for users who operate an
external implementation worker. Chat Pro Repository MCP writes and validates
repository-owned artifacts. Its default MCP server does not select a provider,
load provider credentials, or automatically start a worker or queue consumer.

## Current Delegation V3

The current public names retain `codex` for compatibility:

1. `repo_prepare_codex_task` previews a bound task.
2. `repo_write_codex_task` writes the task artifacts.
3. A separately operated worker writes strict result evidence; when explicitly
   activated, the owner-local App Server runner can consume an exact admitted
   queued `codex_app_server` run.
4. `repo_agent_runs` exposes bounded lifecycle and structured questions.
5. `repo_write_agent_reply` writes an exact current reply artifact.
6. `repo_continue_agent_run` may start one next turn on the same private managed
   App Server session before state-bound review attestation.
7. `repo_codex_review` verifies task, repository, scope, Git, and evidence.
8. `repo_write_codex_review` records the state-bound qualitative verdict.
9. Normal validation, ship review, local commit, and task lifecycle remain
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
| Continuation | existing task/run/revision/operation binding with private session and attempt state |
| Result | immutable bounded outcome with `replay_allowed: false` |
| Recovery | launch intent without result and unknown effects stop without replay |

`repo_task_admission` is the public admission surface, and
`repo_continue_agent_run` is the single public continuation mutation. The separate owner-local queue
consumer, dispatch store, launcher interface, App Server adapter, private
thread/turn identifiers, and notification sink are internal runtime components.
They are not a second MCP server, scheduler, status plane, or control plane.
Default HTTP server construction creates only a lazy client for the existing local
owner control socket; it does not start a provider or queue consumer. When
separately activated, `owner-agent-runner` scans exact open task registrations,
creates one never-approve workspace-write/network-disabled thread per admitted
initial run, and persists the returned private binding before notification
delivery. Provider-free
qualification injects deterministic fakes and proves one launch or turn start
per admitted operation without model contact. The connection also
provides the narrow notification-delivery barrier that prevents an immediate
terminal sink write from racing the bridge's accepted running-state write.

Provider adapter names, model ids, private thread ids, credentials, commands,
retry controls, and raw logs stay outside public MCP inputs. A live adapter must
be separately activated under current authority and cannot widen repository
scope or bypass validation and review.

Continuation calls `thread/read`, conditionally `thread/resume`, and
`turn/start`. It refuses active or mismatched threads, preserves Local sandbox
and approval authority by sending no overrides, and does not require exact
HEAD/tree agreement merely to continue. The existing task operation ledger is
the replay boundary. A confirmed pre-start rejection may restore the prior
settled attempt; an acknowledged or uncertain start remains in-flight and
cannot be blindly replayed. `repo_agent_runs` stays the sole public lifecycle
observer. The bridge never grants App Server approval: known command/file
requests are canceled or aborted, and permission requests receive an empty
grant. Only safe structured `item/tool/requestUserInput` questions are routed
through the existing `repo_write_agent_reply` artifact; unsafe or unanswerable
requests receive an empty answer map.

## Compatibility Rules

- Treat public tool names, schema fields, artifact versions, hashes, and stale
  behavior as contracts.
- Keep parsing bounded, identity-bound, redacted, and fail-closed.
- Keep provider execution and credentials outside MCP handlers and default server construction.
- Do not reopen private worker artifacts through generic repository reads.
- Require documented migration and contract tests for persisted-format changes.
