# Architecture

Chat Pro Repository MCP is a contract-first, local-first MCP server. The public
surface is a closed catalog of exactly 66 tools. Task/worktree lifecycle is
local; only the GitHub-enabled external subset is open-world because it
contacts the configured Git remote and GitHub.

## Contract-First Tool Path

Every tool follows one path:

```text
src/contracts/*.contract.ts
  -> src/tools/contracts.ts
  -> src/tools/packages/*.ts
  -> src/tools/registry.ts
  -> src/register.ts + src/tools/define-tool.ts
  -> src/tools/handlers/*.ts
  -> src/services/*.ts
```

- Contract modules own strict Zod input/output schemas.
- `src/tools/contracts.ts` is the only tool-name-to-contract map.
- Package modules attach title, description, annotations, tier, capability, and
  thin handler.
- `src/tools/registry.ts` rejects duplicates, missing definitions, and unknown
  definitions, then constructs the canonical 66-tool order.
- `src/register.ts` iterates that registry and registers each tool through
  `src/tools/define-tool.ts`.
- Handlers parse, call one runtime/service boundary, audit safe metadata, and
  return a shared envelope.
- Services own policy, state, Git, filesystem, artifacts, and external effects.

The first 47 local names are preserved exactly. Managed-agent continuation is
position 48, followed by the 18 lifecycle names listed in
[Tool Surface](TOOL_SURFACE.md); compatibility aliases are not registered.

## Runtime Construction Seams

The server construction root creates a `RuntimeContext` and passes it to every
registered handler. Its dependencies are deliberately explicit:

- `RootRegistry` resolves registered repository ids to canonical roots and
  policy;
- optional code intelligence is injected behind its client factory;
- `AgentContinuationRuntime` is injected behind the one continuation handler;
  default construction supplies a lazy local App Server control connection;
- `LifecycleRuntime` is the strict handler boundary for the 18 lifecycle tools;
- task-state/worktree storage owns task bindings and terminal state;
- the artifact store owns content-addressed bytes and opaque public ids;
- the optional Git push boundary accepts a fixed argument shape for the
  server-owned task branch only; and
- the optional `GitHubAdapter` owns repository, pull-request, CI, review, merge,
  and post-merge operations using installed `gh` fixed subcommands and JSON.

Production wiring uses the real fixed boundaries. Tests inject deterministic
fakes and make no live GitHub contact. Neither interface exposes an arbitrary
command, URL, repository selector, branch selector, or credential value.

The continuation runtime lazily connects to the existing owner Codex App Server
Unix control socket only when the continuation tool is called. It validates an
owner-only, same-user, non-symlink socket and parent directory, rejects writable
or symlinked ancestors, revalidates socket identity after connection, initializes one
JSON-RPC connection, and calls `thread/read`, `thread/resume`, and `turn/start`
without model, cwd, sandbox, approval, or machine overrides. It requires the
returned thread repository and provider to match the private run session, while
deliberately not requiring the current worktree HEAD or tree to equal an earlier
baseline. Startup does not contact, spawn, configure, or authenticate a provider.
The internal event sink settles the existing run status; there is no second
status system.

If a restart leaves an exact persisted App Server turn id in an in-flight
attempt, the same continuation boundary performs a query-only `thread/read`
with turns included. It rebinds the sink only when that id is unique and latest,
settles an already-terminal turn through the existing status machinery, and
never resumes or starts a replacement turn. Server requests on the bridge
connection are always resolved: approvals receive protocol-valid least-authority
negative results, unsafe questions receive empty answers, and other methods
receive bounded JSON-RPC errors.

Initial execution is owned by the separate `owner-agent-runner` process, not by
the HTTP MCP server. It rehydrates open task registrations, scans only exact
admitted `codex_app_server` queue entries, and reuses the existing immutable
dispatch and launch-intent boundary. One accepted launch calls `thread/start`
with the canonical task root, `approvalPolicy: never`, and the workspace-write
sandbox, verifies the returned root/provider/model and network-disabled sandbox,
then durably binds one `turn/start`. The returned model/provider are observed and
persisted; no model slug, repository identity, user path, or thread id is built
into product source.

The process exposes no HTTP, MCP, registration, or remote-control endpoint. It
retains the originating App Server connection only for fail-closed server
requests and terminal delivery. After restart it queries `thread/read` only when
an exact in-flight turn id is already durable; it never calls `thread/start`,
`thread/resume`, or `turn/start` as recovery. Missing or ambiguous effect evidence
remains no-replay.

## Local Repository Plane

The root registry is the sole repository admission boundary. Explicit roots
are canonicalized directly; owner-configured project roots expand read-only to
their direct, real child directories that are exact standalone Git worktree
roots. Linked worktree and submodule `.git` indirection files are not admitted.
Explicit repository entries override a discovered child root; a project root
inside an explicit repository, an ambiguous id, or a project-root overlap fails
closed. Sandboxed path
resolution canonicalizes each target under its root, applies ignore and secret
classification, rejects traversal and symlink escape, and enforces size limits.

Write policy, operations policy, validation profiles, expected file bytes,
expected HEAD, exact staged paths, and review evidence are checked in services,
not trusted from host confirmation or model reasoning.

## Task And Worktree Plane

A task manifest binds:

```text
task id + base repo + base branch + base commit + base tree
+ authority + exact goal + branch slug
```

The server derives a task repository id, task branch, and isolated worktree.
The task cannot escape its registered base repository or increase its bound
authority. State transitions are open -> closed -> cleaned; cleanup is limited
to server-owned resources.

A lifecycle policy is either `local` or `github`. Both share task authority,
allowed base branches, worktree root, clean-base admission, concurrency, and
cleanup rules. The local form ends at reviewed local Git. The GitHub form adds
remote identity, repository identity, checks, merge method, and external-effect
policy. Legacy policy objects without a discriminator are parsed as GitHub
policies.

Managed-agent continuation reuses that same task identity and its existing
operation ledger. Private `runner.session.json` and `runner.attempt.json`
artifacts bind thread, turn index, and in-flight state. Generic repository reads
exclude them, and public MCP results contain neither App Server thread nor turn
identifiers. The in-flight attempt and operation contact state are crash-durable
before `turn/start`. The local connection buffers notification delivery until
the bridge has persisted accepted running state, then dispatches the buffered
events without waiting on the continuation's task/run locks. The sink advances
the existing status monotonically to a terminal revision. Turn-start barriers
on the shared connection serialize, and a terminal notification receives at
most one same-message local settlement retry. Once `turn/start` may
have been accepted, the operation is unknown/no-replay rather than retried under
a new id. A later operation may only query-reconcile an exact persisted turn id;
missing or ambiguous ids stay blocked, and missing status cannot make an old
result reviewable.

## External Effect Plane

This plane exists only for a GitHub lifecycle policy. A local lifecycle is
rejected with `LIFECYCLE_POLICY_DENIED` before any adapter call. When enabled,
push and GitHub API work are separate seams:

```text
exact task state -> durable pre-contact record -> fixed external call
                 -> authoritative read-back -> durable effect classification
```

`repo_write_push` uses Git directly with a fixed argument vector, exact branch,
fast-forward-only policy, and no force. GitHub operations use `GitHubAdapter`
through `gh`. Mutating or external requests carry an operation id and exact task
state so an identical request can be recognized and stale requests fail closed.

When a process exits after contact but before a normal response, recovery reads
the durable contact record and authoritative remote state. It reports no
change, a confirmed effect, or a queryable/uncertain effect; it does not
silently replay.

## Merge Approval Plane

Merge preparation is read-only. It creates an expiring manifest binding the
repository, task, pull request, base and task branches, exact HEAD and tree,
merge method, mandatory remote-task-branch retention, CI runs, review threads,
timestamps, and manifest digest.

The owner CLI is the only approval writer:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

The CLI resolves the content-addressed gate, displays its bound details,
requires owner confirmation, and writes a mode-0600 approval. Merge consumes
that approval once. Changed or expired bindings require a newly prepared gate
and a new owner decision.

## Artifact Strategy

Lifecycle services keep durable evidence outside normal source reads. Public
results contain opaque ids and hashes, not local paths. The single public
conversion seam resolves an `artifact_id` to internal storage identity;
callers cannot choose a filesystem location.

Artifacts hold task manifests, operation receipts, bounded validation logs,
large diffs, remote observations, push and pull-request evidence, review and CI
evidence, merge-gate evidence, merge receipts, and post-merge evidence.
`repo_artifact_read` streams bounded byte windows with a digest and EOF state.

## Transport Plane

The MCP HTTP service binds to loopback and is started on port `8789` by the
public package script. `/health` is a minimal local liveness endpoint and `/mcp`
is the Streamable HTTP endpoint. ChatGPT reaches it only through an activated
OpenAI Secure MCP Tunnel. The repository does not own tunnel credentials or
publish a public ingress endpoint.

## Semantic Worker Execution Boundary

Delegation uses versioned repository-owned task, result, interaction, and review
artifacts. The provider-neutral execution substrate adds three bounded layers:

1. `repo_task_admission` reads whether the expected exact task is absent, is the
   sole matching active task, or conflicts with active lifecycle state.
2. An admitted Delegation v3 run receives one immutable dispatch record followed
   by at most one immutable launch-intent record.
3. A supervisor-owned queue consumer records typed service identity and health,
   then accepts one bounded launch outcome. A persisted launch intent without a
   result, or any unknown effect, is terminal no-replay evidence.

The normal HTTP server construction does not start that queue consumer, select a
provider, or spawn an App Server. A separately activated owner-local runner is
the only production queue consumer; it uses the already managed App Server socket
and makes no credential, daemon, remote-control, or repository-policy changes.
The launcher and continuation connection remain injectable boundaries, so provider-free tests can qualify
admission, dispatch, continuation, exactly-once, health, privacy, and no-replay
semantics without contacting a model. Provider adapters, credentials, model
selection, and live execution authority remain outside public MCP inputs and
HTTP server startup. A worker result is evidence; repository validation and
review remain authoritative.
