# Contributor Quality Rules

## Architecture Invariants

- Preserve `contracts -> tool-contract map -> packages -> registry ->
  registration -> handlers -> services`.
- Keep exactly 66 canonical names in registry order unless an intentional public
  contract change is approved. Do not add aliases.
- Keep Zod objects strict and schemas centrally referenced.
- Keep package definitions metadata-only, handlers thin, and effects in
  services.
- Keep runtime construction explicit and dependency-injectable.

## Effect And Adapter Invariants

- Mutating or external lifecycle inputs use `operation_id`, task identity, and
  exact expected HEAD/tree as applicable.
- Push uses a separate fixed-argument Git boundary for the exact server-owned
  task branch, fast-forward-only, never force.
- GitHub operations use a strict adapter around installed `gh` fixed
  subcommands and bounded JSON.
- Tests use deterministic fakes and never contact live GitHub.
- External writes persist pre-contact, post-contact, read-back, and replay
  evidence.
- Artifact reads accept opaque ids and bounded byte windows, never paths.
- Task admission is read-only and distinguishes absent, matching, and
  conflicting active task state from exact durable and Git read-back evidence.
- Admitted dispatch, launch intent, and launch result records are immutable;
  one launch intent is the replay boundary, and unknown effects never retry.
- Supervisor identity and health attestations are typed and content-bound; the
  default server does not auto-start a provider queue consumer.
- Managed continuation reuses task `operation_id` state and private
  runner-session/attempt artifacts; it does not require exact HEAD/tree merely
  to start the next turn and never exposes private App Server identifiers.
- Attempt and operation guards are crash-durable before `turn/start`, and the
  internal notification barrier prevents immediate completion from being
  overwritten by a late running-state write. Shared barriers serialize instead
  of turning cross-run contention into an unknown effect.
- An acknowledged or uncertain `turn/start` is no-replay. Deterministic tests
  cover active-turn rejection, confirmed no-start recovery and persistence
  failure, disconnect, immediate completion, fresh/stale result settlement,
  sequential structured questions, human-wait runtime exclusion, approval
  non-response, bounded terminal settlement retry, unsafe socket ancestors,
  missing-status stale-result suppression, duplicate operation, strict input,
  and private-artifact exclusion.
- Merge preparation is read-only; only the owner CLI writes a one-time exact
  approval.

## Annotation Invariants

Use annotations that describe the real tool effect:

- local reads: read-only, closed-world, idempotent;
- local safe state changes: non-destructive where accurate and idempotent when
  protected by exact replay;
- cleanup/removal: destructive and idempotent;
- remote observations: read-only, open-world, idempotent; and
- remote mutations: open-world with accurate destructive classification and
  exact-operation idempotency.

Annotations never replace server authorization.

## Security Invariants

- No arbitrary shell, process, Git command, GitHub request, root-registration,
  or credential-read tool.
- Preserve canonical-root, traversal, symlink, ignore, secret, size, denied
  path, expected-content, exact Git state, and approval checks.
- Keep release, deployment, signing, and publication outside product tools.
- Keep Secure MCP Tunnel credentials outside the repository.

## Required Verification

Run focused tests for changed contracts or services, then:

```bash
npm run typecheck
npm test
npm run lint
npm run check:public
npm run verify:dist
git diff --check
```

Run the content-bound security export and scan from
[Dependency Security](DEPENDENCY_SECURITY.md) after the candidate is clean.

Tool-surface changes require order/count, contract identity, strict-schema,
annotation, registration, and MCP discovery tests. Lifecycle service changes
also require crash/replay, stale-state, deterministic adapter, artifact, and
owner-approval tests.

## Public Documentation

Before release, confirm README, capability, architecture, security, setup,
tool-surface, lifecycle, error/recovery, dependency, migration, and NOTICE
content match the built behavior. Public examples must use placeholders and
must not contain machine-specific owner paths, credentials, real repository
data, Tunnel IDs, or account names.
