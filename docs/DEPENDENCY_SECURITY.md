# Dependency Security

Dependencies are pinned through `package.json` and `package-lock.json`. Review
updates as code changes: inspect provenance, runtime reachability, lockfile
diffs, licenses, advisories, and the exact validation surface.

## Current Runtime Set

The direct runtime dependencies are the MCP SDK, Express, Ignore, TypeScript,
and Zod. `@hono/node-server` has a deliberate compatible override selected by
the lockfile. Remove or change an override only after the owning direct
dependency declares a safe compatible range and integration coverage passes.

## Update Procedure

1. Start from a clean trusted checkout.
2. Inspect the proposed direct and transitive version changes.
3. Update only the intended dependency set and regenerate the lockfile.
4. Review `npm ls` and both production-only and full audit output.
5. Trace every advisory to runtime or development reachability.
6. Run the complete deterministic verification below.
7. Record any temporary exception with package, path, severity, rationale,
   expiry, and removal condition in the repository security policy.

Do not use `npm audit fix --force`; it can replace compatible protocol and
transport dependencies with an older or breaking graph.

## Verification

```bash
npm ci
npm audit --omit=dev
npm audit
npm ls @modelcontextprotocol/sdk @hono/node-server express ignore zod
npm run typecheck
npm test
npm run lint
npm run check:public
npm run security:scan
npm run verify:dist
git diff --check
```

Lifecycle implementation tests must use deterministic GitHub and push fakes;
dependency verification must not contact a live repository or mutate GitHub.
A new production advisory, license incompatibility, unexplained package,
expired exception, or unreviewed lockfile churn blocks release preparation.
