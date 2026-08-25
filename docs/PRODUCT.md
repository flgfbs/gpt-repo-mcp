# Product Principles

Chat Pro Repository MCP helps a developer use ChatGPT against real registered
repositories while keeping local and external effects narrow, visible,
recoverable, and owner controlled.

## Intended User

The primary user is a solo developer or small technical team that wants
ChatGPT to understand, edit, validate, review, commit, and isolate task
worktrees. A repository may stop at reviewed local Git or, when explicitly
configured for GitHub lifecycle, continue through Draft PR, CI, review, and an
exact owner-approved merge.

## Expected Experience

Ordinary work should remain simple:

```text
understand -> edit -> validate -> review -> local commit/recovery
```

Task work adds explicit isolation first, and external state only when selected:

```text
local:  open task -> implement -> validate/review -> local commit -> close/cleanup
github: local path -> push -> Draft PR -> CI/review -> exact merge gate
                   -> owner approval -> merge/read-back
```

Specialist tools such as code indexing, patchsets, work sessions, failure
diagnosis, artifacts, and external-worker evidence remain optional.

## Product Promises

- Only owner-registered repositories and exact Git children of
  owner-registered project roots are available.
- Repository mode and task authority are explicit and never increased by a
  model or tool.
- Local-only lifecycle never requires or synthesizes a remote and rejects every
  external lifecycle operation before contact.
- The 64 public tools are focused schemas, not an arbitrary shell or API.
- Actual file bytes, Git objects, validation, review, and remote read-back take
  precedence over claims.
- Push is task-branch-only, fast-forward-only, and non-force.
- Pull requests stay Draft through the create/update boundary.
- Merge requires one exact, unexpired owner approval and post-merge read-back.
- Interrupted external effects are queried and classified before replay.
- Errors and artifacts are bounded and do not expose credential material.

## User Control

The owner chooses registered roots and modes, task goals and maximum authority,
whether host confirmations are automatic, and whether to approve one exact
merge gate. ChatGPT chooses an efficient path within those limits. The server
enforces them independently.

**Allow all actions** is a host convenience. It does not alter repository
configuration, credentials, task authority, state binding, or merge approval.

## External Workers

Current delegation tools can exchange bounded artifacts with a separately
operated implementation worker. The future Semantic Worker direction makes
those contracts provider-neutral. Neither current nor future design places
provider credentials or unrestricted worker execution inside this MCP server.

## Scope Limit

`ship` covers reviewed local Git. The exact task-bound GitHub lifecycle is an
additional repository policy, not an automatic consequence of `ship`. Neither
form includes release, deployment, signing, publication, environment mutation,
or infrastructure administration.

Public names, strict payloads, order, error semantics, artifact identities, and
approval behavior are compatibility contracts. Breaking changes require an
explicit migration and release note.
