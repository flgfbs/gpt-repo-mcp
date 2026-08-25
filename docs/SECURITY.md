# Security And Threat Model

Chat Pro Repository MCP gives ChatGPT bounded repository capability without
turning the model or MCP client into a filesystem, shell, Git, GitHub, or
deployment administrator.

## Security Model At A Glance

- Only owner-registered canonical repository roots and read-only exact Git
  children of owner-registered project roots are visible.
- Every repository has deny-first read, write, Git, validation, and cleanup
  policy.
- Tools accept structured schemas, not arbitrary commands.
- Local paths are canonicalized and constrained beneath one root.
- Task work is bound to exact base and current Git objects.
- External calls are operation-bound and state-bound.
- Push is fixed-argument, exact-branch, fast-forward-only, and non-force.
- GitHub access uses a strict adapter around installed `gh` fixed subcommands
  and JSON.
- Merge requires one exact, unexpired, one-time owner CLI approval.
- External effects have durable pre-contact, post-contact, and read-back state.

## Assets And Trust Boundaries

Protected assets include repository source, Git history, registered roots,
task worktrees, local configuration, credentials, GitHub state, validation and
review evidence, merge approvals, and lifecycle artifacts.

Trust is split among:

1. the repository owner and owner CLI;
2. ChatGPT and the MCP host approval interface;
3. the local MCP server and its configuration;
4. installed Git and `gh` executables; and
5. GitHub and the OpenAI Secure MCP Tunnel service.

Host approval is advisory input to the server, not an authority source.
Installed GitHub authentication authorizes `gh` to contact GitHub, but tools do
not receive, read, or return the credential material.

## Threats And Controls

| Threat | Control |
| --- | --- |
| Model requests an unapproved repository | `repo_id` must resolve in the owner-managed root registry. |
| Path traversal or symlink escape | Canonical root containment and symlink checks fail closed. |
| Secret disclosure | Secret-like paths, credential files, environment secrets, and private artifacts are excluded. |
| Arbitrary local execution | No shell or arbitrary process/Git command schema exists; validation uses allowlisted profiles. |
| Stale mutation | Expected bytes, HEAD, tree, staged paths, thread version, CI snapshot, and gate digest are checked where applicable. |
| Replay after crash | `operation_id` plus durable operation/contact records distinguish replay from a new effect. |
| Force push or wrong branch | Push receives only the server-owned task branch and cannot enable force. |
| Arbitrary GitHub access | The strict adapter derives repository, branch, PR, run, and thread targets from task state. |
| Unapproved merge | Only a fresh owner-CLI approval for the exact content-bound gate is consumable. |
| Oversized evidence | Bounded reads and opaque artifact paging cap returned bytes. |

## Repository And Credential Boundaries

No tool adds, removes, or widens repository or project roots. Only the owner
CLI edits the local registry. Project discovery is one directory deep,
read-only, rejects symlink roots, skips `.git` indirection files, rejects
ambiguous or overlong ids, and gives each discovered standalone Git worktree
its own canonical sandbox. Exclusions are case-insensitive. Explicit child
repositories may override discovered policy, but project roots inside explicit
repositories fail closed. A task may narrow authority from repository policy;
it cannot widen it.

No tool reads credential stores, access tokens, API keys, SSH keys, environment
secret values, Git credential helpers, or `gh` authentication state. The GitHub
adapter invokes an already installed and authenticated `gh` with fixed
subcommands and parses bounded JSON. It never returns credentials or raw
process output.

## Local Mutation Boundaries

Writes require explicit repository policy and repo-relative allowed paths.
Hard-denied and secret-like paths win over allowed globs. File mutation uses
exact-content or exact-state guards. Git stage, unstage, commit, restore, and
cleanup operate on explicit reviewed paths; there is no reset, stash, broad
clean, history rewrite, or arbitrary Git escape hatch.

Validation accepts named profiles such as test, build, lint, typecheck, smoke,
or all. Resolution is constrained to configured targets and supported safe
project runners, never caller-supplied shell text.

Exact terminal Delegation v3 finalization has a separate default-off repository
capability, `operations.codex_run_finalize_enabled`. It does not depend on or
enable generic Git operations. The finalizer accepts no command string and is
bound to one run, terminal status revision, branch, HEAD, tree, exact regular
UTF-8 changed files and SHA-256 values, manifest authorization, commit message,
and archive label. It runs only the fixed provider-free unittest route. Git
children disable repository fsmonitor, maintenance, submodule recursion, hooks,
lazy fetch, replacement objects, pagers, external diff, and text conversion.
The finalizer compares the bound tree and index directly, hashes no-follow raw
worktree bytes, writes changed blobs with `hash-object --no-filters`, builds the
candidate tree in a temporary index, and advances the exact branch only through
a compare-and-swap `update-ref`. The archive is emitted by a server-owned exact
USTAR writer from bytes verified against the committed blob ids, so clean
filters, `export-ignore`, and `export-subst` cannot change its contents. It
creates one unsigned local commit, verifies the complete committed regular-file
tree and exact archive bytes, and fails closed on replay or partial-effect
ambiguity.

## External And Merge Boundaries

`ship` is required for push and pull-request mutation. External requests bind
`repo_id`, `task_id`, `operation_id`, and exact expected HEAD/tree as applicable.
Draft pull requests remain Draft through the create/update tool.

`repo_merge_gate_prepare` performs a read-only fresh observation. An eligible
gate binds the pull request, branches, HEAD, tree, configured merge method,
mandatory remote-task-branch retention, CI, review state, digest, and expiry.
The owner then runs:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

The CLI displays the exact binding, confirms it, and stores a mode-0600
approval. `repo_write_merge` consumes that approval once. A mismatch or expiry
requires a new gate and new owner approval. `repo_post_merge_readback` verifies
the result; an empty or interrupted response is not treated as permission to
replay.

## ChatGPT Approval Is Not Server Authority

Selecting **Allow all actions** in ChatGPT can reduce repeated host prompts. It
does not broaden server authority. It cannot register roots, enable writes,
raise a task from `inspect` or `implement` to `ship`, bypass exact-state checks,
read credentials, permit force, mint merge approval, or enable release or
deployment.

## What Stays Local And What Is Sent To ChatGPT

Local configuration, canonical root paths, credential material, private worker
state, approval files, raw command output, and internal artifact paths stay
local. Tools return bounded structured results, repo-relative paths, sanitized
diagnostics, hashes, and opaque ids. File content and diffs are returned only
through the bounded repository tools the caller invokes.

The Secure MCP Tunnel forwards MCP traffic to the loopback server. It does not
change tool authority or make the repository a hosted service. This repository
does not store tunnel credentials or document a public ingress fallback.

## Residual Risk

The server reduces authority; it is not an operating-system sandbox. The local
owner remains responsible for the machine, installed executables, GitHub
account permissions, repository hooks, dependency scripts run manually, and
the confidentiality of content intentionally returned to ChatGPT.

Release, deployment, signing, package publication, and infrastructure changes
are out of scope even when repository and task mode are `ship`.
