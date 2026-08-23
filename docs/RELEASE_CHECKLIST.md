# Project Release Checklist

This checklist covers releasing Chat Pro Repository MCP itself. Its MCP tools do
not release or deploy user repositories; publication remains a separate owner
operation.

## Contract And Documentation

- Confirm the public registry contains exactly 63 canonical names in order and
  no aliases.
- Confirm strict schemas, descriptions, annotations, handlers, and runtime
  capabilities agree.
- Confirm README and docs describe loopback port `8789`, OpenAI Secure MCP
  Tunnel only, current CLI commands, task authority, Draft PR behavior, exact
  merge approval, crash recovery, and out-of-scope operations.
- Confirm [NOTICE](../NOTICE) preserves upstream repository, commit, tree,
  copyright, and license attribution.
- Confirm migration and changelog entries describe every public incompatibility.

## Deterministic Verification

From a clean checkout:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run check:public
npm run security:scan
npm run verify:dist
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

Lifecycle tests must use deterministic fakes. Do not contact live GitHub, push,
create a pull request, retry CI, resolve a review, or merge as an implementation
test.

## Security Review

- No tracked config, task state, artifacts, approval files, credentials, local
  paths, real Tunnel IDs, or account data.
- Server still binds to loopback and public docs expose only Secure MCP Tunnel.
- No tool adds roots, reads credentials, executes arbitrary commands, forces a
  push, or performs release/deployment work.
- GitHub adapter and Git push boundary remain fixed and separately testable.
- Owner approval remains exact, expiring, mode 0600, and one-time.
- Dependency and license policy passes; no forced audit fix was used.

## Packaging And Publication

- Verify package name, version, license, privacy setting, executable, and packed
  file list.
- Install the packed archive in a temporary test directory and verify build,
  CLI help, config validation, doctor, server start, and health.
- Create tags, releases, registries, signatures, or deployments only under a
  separate explicit owner decision.
- After publication, read back the exact tag, assets, package metadata, and
  documentation links.
