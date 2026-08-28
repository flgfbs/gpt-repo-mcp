# Contributing

## Setup

```bash
npm ci
cp config.example.json config.local.json
npm run build
```

Use only synthetic repositories for tests that exercise mutation. Tests must
not contact live GitHub or depend on an authenticated account.

## Architecture Rules

- Preserve the contract-first flow: contracts -> tool-contract map -> packages
  -> registry -> registration -> handlers -> services.
- Keep the exact 66-name canonical order unless a deliberate public contract
  change is approved and documented. Do not add aliases.
- Keep handlers thin and policy or effect logic in services.
- Keep GitHub access behind the strict adapter and installed `gh` fixed-command
  boundary. Use deterministic fakes in tests.
- Keep push behind its separate fixed-argument Git boundary; never force.
- Require operation identity and exact state for mutating or external calls.
- Never add root-registration, credential-reading, shell, arbitrary Git,
  arbitrary GitHub API, release, or deployment tools.

## Checks

Run focused tests first, then the relevant full checks:

```bash
npm run typecheck
npm test
npm run lint
npm run check:public
npm run security:scan
npm run verify:dist
git diff --check
```

Dependency updates must be intentional, lockfile-reviewed, and validated under
the procedure in [docs/DEPENDENCY_SECURITY.md](docs/DEPENDENCY_SECURITY.md).
