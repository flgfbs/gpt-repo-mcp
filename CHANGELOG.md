# Changelog

Notable public changes to Chat Pro Repository MCP are recorded here.

## Unreleased

### Added

- `repo_write_push_reconciliation` を位置68に追加。元の UNKNOWN push を変更・再送せず、
  後続の native remote observation と現在の公開確認を追記型 v1 証拠へ結合します。
  既定は検査のみ、追記は二つの state digest 必須です。merge/review resolution は
  読戻し検証済みの証拠だけを参照し、他の条件や owner approval を免除しません。

- Local-only lifecycle policy for isolated task worktrees, validation, reviewed
  local commits, close, and cleanup without any Git remote or GitHub authority.
- Owner CLI `--local-only` registration with explicit conflict rejection for
  remote, GitHub, required-check, and merge-method options.
- One operation-bound `repo_continue_agent_run` bridge for continuing the
  private session of an existing managed Codex App Server child without public
  thread, model, machine, path, binding, or separate idempotency identifiers.
- Lazy same-user Unix control-socket attachment, terminal settlement, and
  structured-question routing for that bridge without provider startup,
  approval takeover, or startup contact.
- Serialized turn-start barriers, sequential structured-question rounds,
  paused human-wait runtime accounting, and bounded same-notification terminal
  settlement retry.
- Twenty task and optional GitHub lifecycle tools follow the preserved
  47-tool local prefix and the continuation tool, producing an exact 68-tool
  surface with no aliases. The additive `repo_run_fable_review` action provides
  one exact-head, active-task-bound Fable/MAX review through the installed typed
  launcher without widening the generic runner filesystem surface.
- Read-only `repo_task_admission` with typed absent, exact matching active, and
  conflicting active-task outcomes.
- Provider-neutral immutable dispatch, one-launch-intent, supervisor identity
  and health, exactly-once, and unknown-effect no-replay contracts with
  provider-free integrated qualification.
- A separate owner-local `owner-agent-runner` build entrypoint that consumes
  only exact admitted `codex_app_server` runs, creates one workspace-write,
  network-disabled, never-approve thread and turn, and query-rebinds an exact
  persisted in-flight turn after restart without replay.
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
- Agent continuation reuses task `operation_id` receipts, preserves local
  sandbox and approval authority, and becomes no-replay as soon as turn-start
  contact has an unknown outcome.
- Initial App Server execution is outside the HTTP MCP process, exposes no
  listener or public control surface, never grants approval, and records
  uncertain thread/turn starts as unknown/no-replay.
- Merge requires one exact, unexpired approval created by the owner CLI and
  consumed once.
