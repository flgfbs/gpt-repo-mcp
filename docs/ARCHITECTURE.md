# Architecture

Chat Pro Repository MCP is a contract-first, local-first MCP server. The public
surface is a closed catalog of exactly 63 tools; only the lifecycle subset is
open-world because it deliberately contacts the configured Git remote and
GitHub.

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
  definitions, then constructs the canonical 63-tool order.
- `src/register.ts` iterates that registry and registers each tool through
  `src/tools/define-tool.ts`.
- Handlers parse, call one runtime/service boundary, audit safe metadata, and
  return a shared envelope.
- Services own policy, state, Git, filesystem, artifacts, and external effects.

The first 46 names are preserved exactly. The lifecycle package appends the 17
names listed in [Tool Surface](TOOL_SURFACE.md); compatibility aliases are not
registered.

## Runtime Construction Seams

The server construction root creates a `RuntimeContext` and passes it to every
registered handler. Its dependencies are deliberately explicit:

- `RootRegistry` resolves registered repository ids to canonical roots and
  policy;
- optional code intelligence is injected behind its client factory;
- `LifecycleRuntime` is the strict handler boundary for the 17 lifecycle tools;
- task-state/worktree storage owns task bindings and terminal state;
- the artifact store owns content-addressed bytes and opaque public ids;
- the Git push boundary accepts a fixed argument shape for the server-owned
  task branch only; and
- `GitHubAdapter` owns repository, pull-request, CI, review, merge, and
  post-merge operations using installed `gh` fixed subcommands and JSON.

Production wiring uses the real fixed boundaries. Tests inject deterministic
fakes and make no live GitHub contact. Neither interface exposes an arbitrary
command, URL, repository selector, branch selector, or credential value.

## Local Repository Plane

The root registry is the sole repository admission boundary. Sandboxed path
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

## External Effect Plane

Local push and GitHub API work are separate seams:

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
merge method, branch-deletion choice, CI runs, review threads, timestamps, and
manifest digest.

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

## Future Semantic Worker Boundary

Delegation currently uses versioned repository-owned task, result, interaction,
and review artifacts. The intended Semantic Worker evolution makes those
contracts provider-neutral: stable task identity, exact repository baseline,
bounded authority, structured questions and replies, result evidence,
validation references, and terminal status.

Provider adapters, credentials, scheduling, and model execution remain outside
the public MCP server. A worker result is evidence; repository validation and
review remain authoritative.
