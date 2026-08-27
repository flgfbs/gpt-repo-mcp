# Changelog

Notable public changes to Chat Pro Repository MCP are recorded here.

## Unreleased

### Added

- Local-only lifecycle policy for isolated task worktrees, validation, reviewed
  local commits, close, and cleanup without any Git remote or GitHub authority.
- Owner CLI `--local-only` registration with explicit conflict rejection for
  remote, GitHub, required-check, and merge-method options.
- Eighteen task and optional GitHub lifecycle tools appended after the canonical
  47-tool local prefix, producing an exact 65-tool surface with no aliases.
- Read-only `repo_task_admission` with typed absent, exact matching active, and
  conflicting active-task outcomes.
- Provider-neutral immutable dispatch, one-launch-intent, supervisor identity
  and health, exactly-once, and unknown-effect no-replay contracts with
  provider-free integrated qualification.
- Server-bound task worktrees, opaque lifecycle artifacts, exact-state remote
  observation, fixed-argument non-force push, Draft pull requests, review and
  CI handling, exact merge-gate preparation, one-time owner CLI approval, and
  post-merge read-back.
- OpenAI Secure MCP Tunnel as the documented ChatGPT connection path.
- Owner-managed project roots that discover direct Git repositories as
  independent read-only roots without per-repository registration.
- Project-root fail-closed boundaries for explicit-root containment, linked
  worktree indirection, case-insensitive exclusions, generated-id length, and
  structured degraded-list diagnostics.

### Changed

- Legacy lifecycle configuration without a `kind` discriminator remains
  GitHub-backed; new parsed state records `kind: "github"` without requiring a
  migration rewrite.
- External lifecycle tools now fail with `LIFECYCLE_POLICY_DENIED` before
  contact when invoked for a local-only task.
- Npm validation prefers the trusted running Node executable directory, so
  launchd services with a minimal `PATH` can still resolve the matching package
  manager.
- Public naming, commands, documentation, and examples now use Chat Pro
  Repository MCP, `chat-pro-repo`, and loopback port `8789`.
- Push and merge are no longer described as globally absent. They are available
  only through `ship` tasks and their exact-state boundaries.

### Removed

- Public-URL fallback connection scripts and static connector mockups.
- Duplicate or compatibility tool aliases; canonical names are the only public
  names.

### Security

- External operations bind task, operation, HEAD, and tree state.
- Merge requires one exact, unexpired approval created by the owner CLI and
  consumed once.
