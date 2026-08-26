# Chat Pro Repository MCP

Chat Pro Repository MCP is a local-first Model Context Protocol server for
working with explicitly registered repositories and owner-approved project
roots. It gives ChatGPT 66 focused
tools for repository understanding, bounded edits, validation, local Git,
task-isolated worktrees, and—when explicitly configured—GitHub pull requests,
CI, review, and exact-head owner-approved merges.

The server is not a shell and is not a general GitHub client. Repository roots,
task authority, paths, expected Git state, operation identities, and merge
approval are enforced by the server even when ChatGPT is configured to
**Allow all actions**.

### External publication boundary

`NOTICE` records source provenance and license attribution; an upstream or fork parent named there is never publication authority. Repository agents must not push or mutate GitHub through direct `git`, `gh`, raw APIs, browser automation, or another connector. GitHub mutation uses only exact task-bound lifecycle tools. The publication target is derived from the selected Git remote and rechecked before mutation. If it is absent, mismatched, archived, or not writable by the authenticated viewer, stop; never substitute another remote, fork parent, or repository.

## Quick Start

Requirements:

- Node.js 20 or newer;
- Git;
- the GitHub CLI (`gh`) installed and authenticated when GitHub lifecycle tools
  are needed; and
- an OpenAI workspace with Secure MCP Tunnel access for ChatGPT connectivity.

Install from a trusted checkout:

```bash
git clone <repository-url>
cd chat-pro-repository-mcp
npm ci
npm run build
cp config.example.json config.local.json
```

The example configuration is intentionally empty. Register a repository from
the owner terminal with an explicit `read`, `write`, or `ship` mode:

```bash
npm run add -- /path/to/your/repo --mode <mode>
npm run list
npm run check:config
```

To approve every direct Git repository under one project directory without
registering each repository separately:

```bash
npm run add-project-root -- /path/to/projects
npm run list-project-roots
npm run list
```

Project-root discovery is one directory deep and read-only. It ignores non-Git
directories, symlinks, and `.git` indirection files used by linked worktrees or
submodules. Exclusion names are matched case-insensitively. An explicit
repository entry remains the policy override for the same canonical child root;
a project root itself cannot be equal to or nested inside an explicit
repository. Register a repository explicitly with `write` or `ship` when it
needs mutation, isolated task worktrees, or GitHub lifecycle authority.

No MCP tool can add, remove, or widen a repository or project root.
Registration is an owner CLI operation.

Start the loopback server:

```bash
npm run mcp
```

It listens on `127.0.0.1:8789`. In another terminal, verify it:

```bash
curl http://127.0.0.1:8789/health
npm run doctor
```

Activate an OpenAI Secure MCP Tunnel for the loopback MCP endpoint
`http://127.0.0.1:8789/mcp`, then create a custom ChatGPT app using that Tunnel
ID. This repository intentionally does not ship a public-URL fallback or store
tunnel credentials. See [ChatGPT connection](docs/CHATGPT_CONNECT.md).

## Repository And Task Authority

Repository registration sets the maximum local capability:

| Mode | Maximum capability |
| --- | --- |
| `read` | Bounded inspection only. |
| `write` | Inspection and policy-checked repository edits. |
| `ship` | Write capability plus reviewed local Git; GitHub lifecycle is available only under a GitHub lifecycle policy. |

Repositories without a GitHub remote can opt into isolated task worktrees and
reviewed local commits without granting any external authority:

```bash
npm run add -- /path/to/your/repo --mode ship --local-only
```

Existing lifecycle entries without a `kind` field remain GitHub lifecycle
entries for backward compatibility. The CLI writes `kind: "local"` only when
`--local-only` is selected.

`repo_task_open` then creates a narrower task binding with `inspect`,
`implement`, or `ship` authority. It binds the task id, base branch, base commit,
base tree, goal, and branch slug. The server derives and owns the task branch
and isolated worktree.

`repo_task_admission` is the read-only coordinator and supervisor view of this
state. It distinguishes an absent expected task, one exact matching active task,
and conflicting active task state without creating, claiming, closing, or
changing a task.

`ship` task authority admits reviewed local stage and commit operations.
`ship` task authority is required for push and pull-request mutation. Push,
pull-request, CI, review-thread, merge-gate, merge, and post-merge operations
also require the base repository to have a GitHub lifecycle policy. A
local-only task rejects every such operation with `LIFECYCLE_POLICY_DENIED`.
Where enabled, push is fast-forward-only to the exact server-owned task branch
and never uses force; pull requests remain Draft.

## How ChatGPT Works

The ordinary path is:

1. **Understand** the approved repository with bounded tree, search, file,
   context, and Git reads.
2. Open an exact task when isolated implementation or external lifecycle work
   is needed.
3. Edit with policy-checked file or patchset tools.
4. **Validate** through configured profiles; arbitrary commands are not
   accepted.
5. **Review** the actual Git state, semantic risks, validation evidence, review
   threads, and CI for the exact HEAD and tree.
6. Create a reviewed local commit. A local-only task can then be closed and
   cleaned without any remote.
7. Only for a GitHub lifecycle task, use `repo_write_push` and
   `repo_pr_create_or_update` under `ship` authority, then prepare an exact
   merge manifest with `repo_merge_gate_prepare`.
8. For that GitHub merge path, the repository owner runs the one command printed
   by the gate:

   ```bash
   chat-pro-repo approve-merge --gate-id <opaque-id>
   ```

9. `repo_write_merge` consumes that exact, unexpired, one-time approval, and
   `repo_post_merge_readback` confirms authoritative GitHub state.

Changing the HEAD, tree, pull request, CI evidence, review state, merge method,
or expiration invalidates the gate. One owner approval authorizes one exact
merge only.

## Security Boundaries

- **Allow all actions does not broaden server authority.** It affects ChatGPT's
  host confirmation behavior, not registered roots, write policy, task
  authority, exact-state checks, credentials, or owner approval.
- No tool adds repository roots or reads credential stores, tokens, SSH keys,
  environment secrets, or the GitHub CLI authentication material.
- Repository paths remain relative to a registered canonical root; traversal,
  symlink escape, secret-like paths, and hard-denied outputs fail closed.
- Local-only lifecycle policy rejects every remote and GitHub operation before
  external contact. Where GitHub lifecycle is configured, external calls
  require task identity, an `operation_id`, and the exact expected HEAD and
  tree where applicable.
- Unknown push effects are durably classified and read back; they are not
  blindly replayed.
- Managed continuation lazily uses only the existing same-user, owner-only
  Codex App Server control socket, keeps thread/turn ids private, sends no Local
  authority overrides, and leaves App Server approval requests unanswered.
- Release, deployment, signing, package publication, and infrastructure change
  are out of scope.

See the full [security and threat model](docs/SECURITY.md).

## Tool Surface

The public surface is exactly 66 canonical names: the preserved 47-tool local
prefix, one managed-agent continuation tool, and 18 lifecycle tools. There are
no aliases.
See [Tool Surface](docs/TOOL_SURFACE.md) for the complete ordered catalog and
[Capability Guide](docs/CAPABILITIES.md) for task-oriented guidance.

## Operations

| Action | Command |
| --- | --- |
| Build | `npm run build` |
| Start locally | `npm run mcp` |
| Production start after build | `PORT=8789 npm start` |
| Health | `curl http://127.0.0.1:8789/health` |
| Diagnose | `npm run doctor` |
| Validate config | `npm run check:config` |
| Stop | Press `Ctrl-C` in the server terminal. |

For rollback and uninstall, stop the server and Secure MCP Tunnel first,
remove the ChatGPT app/tunnel association, unregister roots with
`npm run remove -- <repo_id>`, and only then remove the local checkout if its
configuration or task artifacts are no longer needed. See [Setup](docs/SETUP.md).

## Documentation

- [Capability Guide](docs/CAPABILITIES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security And Threat Model](docs/SECURITY.md)
- [Setup And Operations](docs/SETUP.md)
- [ChatGPT Connection](docs/CHATGPT_CONNECT.md)
- [Write And Lifecycle Workflows](docs/WRITE_WORKFLOWS.md)
- [Crash And Error Handling](docs/ERRORS.md)
- [Dependency Security](docs/DEPENDENCY_SECURITY.md)
- [Contributor Quality Rules](docs/QUALITY.md)

## License And Attribution

The project is MIT licensed. It incorporates and extends an upstream MIT
project; the exact upstream repository, commit, tree, copyright notice, and
license attribution are preserved in [NOTICE](NOTICE) and [LICENSE](LICENSE).
