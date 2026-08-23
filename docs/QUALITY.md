# Contributor Quality Rules

## Architecture Invariants

- Preserve `contracts -> tool-contract map -> packages -> registry ->
  registration -> handlers -> services`.
- Keep exactly 63 canonical names in registry order unless an intentional public
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
npm run security:scan
npm run verify:dist
git diff --check
```

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
