# Capability Guide

Chat Pro Repository MCP exposes exactly 66 repository tools. The first 47 keep
their canonical local order and semantics; managed-agent continuation is next;
18 task and optional GitHub lifecycle tools follow in one canonical order.
There are no aliases.

## Everyday Repository Work

Use the bounded read tools to list registered repositories, inspect trees,
search, read files, map context, inspect symbols, and review Git state. Direct
edits use `repo_write_file` or `repo_write_changes`; atomic multi-step edits can
use the patchset tools. All paths are repository-relative and server checked.

`repo_validate` runs only configured or safely detected validation profiles.
It does not accept a command line or shell program. `repo_git_review`,
`repo_semantic_review`, and `repo_ship_review` reason from current repository
state and recorded evidence rather than from a claimed result.

## Registration And Permission Modes

Repository roots are registered by the owner CLI, never by an MCP tool:

```bash
npm run add -- /path/to/your/repo --mode <mode>
```

Use `--local-only` for a repository that needs isolated task worktrees and local
Git but must not gain any remote or GitHub authority:

```bash
npm run add -- /path/to/your/repo --mode ship --local-only
```

Choose an explicit `read`, `write`, or `ship` mode. Registration resolves the
canonical root and writes local configuration. A tool cannot add a root, change
its mode, or expand its path policy.

For many sibling repositories, register their owner-controlled parent once:

```bash
npm run add-project-root -- /path/to/projects
```

Direct standalone Git children become independent read-only repository ids with
separate canonical path sandboxes. Symlinks and `.git` indirection files are
excluded; configured directory exclusions are case-insensitive. Add an explicit
`write` or `ship` repository entry only where broader authority is required.

## Task-Isolated Development

`repo_task_open` binds a caller-generated operation id and task id to an exact
base repository, base branch, commit, tree, authority (`inspect`, `implement`,
or `ship`), goal, and lowercase branch slug. The server derives the task branch
and owns its worktree.

Task status, terminal close outcomes (`completed`, `blocked`, `abandoned`, or
`superseded`), and cleanup are explicit. Cleanup acts only on eligible closed,
server-owned task resources and preserves a durable receipt.

`repo_task_admission` is read-only. Given an expected exact task binding, it
returns one of three typed states: no active task, one matching active task, or
conflicting active task state. It never opens, claims, closes, or retries a task.

The lifecycle policy has two forms. `kind: "local"` admits task open/status,
local implementation, validation, review, stage, commit, close, and cleanup.
`kind: "github"` adds the external lifecycle. Legacy entries without `kind`
parse as `kind: "github"`, preserving existing configuration behavior.

## Continue A Managed Local Child

`repo_continue_agent_run` starts one next turn on the same private Codex App
Server thread already bound to an existing managed run. The default server
lazily connects to the safely permissioned existing owner control socket when
the tool is called and holds notification delivery through accepted
running-state persistence. Startup does not find, register, spawn, contact, or
authenticate a provider.

Use the exact task `repo_id`, `run_id`, current `repo_agent_runs` revision, a
fresh `operation_id` in the existing task namespace, and the bounded next-turn
instruction. The tool does not accept a thread id, model, machine, repository
path, sandbox, approval, binding id, separate idempotency key, or expected
HEAD/tree. It validates the private session's repository and provider instead,
so normal child edits do not create false drift.

Only an idle, terminal, managed run without a state-bound review attestation is
continuable. Use `repo_write_agent_reply` when the run is awaiting structured
input. The bridge never approves a command, file change, or permission expansion:
known command/file requests are canceled, permission requests receive the empty
subset, and other server requests fail closed. After a formal review attestation,
use the bounded corrective-child lineage. If `turn/start` disconnects or returns
an invalid acknowledgement, the result is unknown/no-replay: inspect the same run
and do not resend the instruction. When the exact App Server turn id was already
persisted, a fresh operation may read and rebind that unique latest turn without
resuming or restarting it; absent or ambiguous ids remain blocked. Missing or
invalid managed status also suppresses stale result review while in-flight private
attempt evidence remains.

## Validation, Git, And Recovery

Local mutation remains deny-first:

- file edits require enabled write policy and allowed paths;
- validation is allowlisted;
- stage and commit require reviewed paths and exact Git state;
- restore and cleanup are path-scoped, never broad reset or clean; and
- repeated mutating calls use `operation_id` replay protection where the
  contract requires it.

Crash recovery begins with `repo_task_status`, `repo_last_write`,
`repo_operation_ledger`, or the relevant remote status/read-back tool. An
unknown external effect is queried and classified before any retry.

## GitHub, Pull Requests, CI, And Review

These capabilities require a `kind: "github"` lifecycle and `ship` task
authority. A local-only task rejects every external lifecycle call with
`LIFECYCLE_POLICY_DENIED` before remote contact. GitHub lifecycle calls use an
installed authenticated `gh` process through a strict adapter with fixed
subcommands and JSON parsing. Tests use a deterministic
fake; implementation tests do not contact GitHub.

For a `ship` task, the server can:

- observe exact remote refs;
- fast-forward push the exact server-owned task branch without force;
- create or update its pull request while keeping it Draft;
- read pull-request status and bounded review threads;
- reply to or version-safely resolve a bound review thread;
- read GitHub Actions state for the exact task HEAD; and
- retry only failed run ids from a bound CI snapshot.

Every external input carries an `operation_id`, task identity, and expected HEAD
and tree where applicable. A caller cannot supply an arbitrary repository,
branch, pull-request number, URL, Git command, or GitHub command.

## Exact-Head Merge

`repo_merge_gate_prepare` is read-only. It re-reads pull-request, review, CI,
branch, HEAD, tree, the configured merge method, and mandatory remote-branch
retention state and returns either blockers or an expiring content-bound
manifest. When eligible it prints:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

Only the repository owner runs that CLI command. The CLI shows the bound gate
details, confirms them, and writes an owner-only approval. `repo_write_merge`
can consume that exact approval once while it is unexpired and all bound state
still matches. `repo_post_merge_readback` then verifies GitHub state.

ChatGPT's **Allow all actions** option does not replace or widen this approval.

## Artifacts And Bounded Evidence

Large or durable evidence is returned as an opaque `artifact_id`, media type,
length, SHA-256, and timestamp. `repo_artifact_read` accepts only `repo_id`, the
opaque id, a byte offset, and a length of at most 65,536 bytes. It never accepts
a path.

Artifact kinds cover task manifests, operation receipts, validation logs,
large diffs, remote observations, push receipts, pull requests, review
evidence, CI evidence, merge-gate evidence, merge receipts, and post-merge
evidence.

## Specialist Capabilities

Context maps, optional code indexing, failure diagnosis, decision memory,
work sessions, transactional patchsets, and delegation artifacts are available
when a task benefits from them. They are not mandatory workflow ceremony.

The current delegation format interoperates with external workers through
repository-owned artifacts. Its provider-neutral execution substrate can bind
one admitted dispatch to one supervisor-owned launch intent, publish typed
service health, and stop permanently on an unknown effect. The normal MCP server
does not auto-start the queue consumer, choose a provider, or attach an App
Server connection, and no public input accepts credentials, model identifiers,
commands, private thread ids, or retry authority.

## What Chat Pro Repository MCP Does Not Do

The server deliberately does not provide:

- arbitrary shell, process, Git, or GitHub API execution;
- root registration or permission expansion through MCP tools;
- credential-store, token, environment-secret, or SSH-key reads;
- force push, history rewrite, arbitrary branch selection, or branch deletion;
- merge without one exact owner CLI approval;
- automatic implementation-agent execution or provider authentication; or
- release, deployment, signing, publication, or infrastructure operations.

See [Tool Surface](TOOL_SURFACE.md), [Write Workflows](WRITE_WORKFLOWS.md), and
[Security](SECURITY.md) for the exact contracts and boundaries.
