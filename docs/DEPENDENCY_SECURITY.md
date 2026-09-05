# Dependency Security

Dependencies are pinned through `package.json` and `package-lock.json`. Review
updates as code changes: inspect provenance, runtime reachability, lockfile
diffs, licenses, advisories, and the exact validation surface.

## Current Runtime Set

The direct runtime dependencies are the MCP SDK, Express, Ignore, TypeScript,
WebSocket (`ws`), and Zod. `ws` is used only by the lazy same-user Unix control
socket client for managed continuation. `@hono/node-server` has a deliberate
compatible override selected by the lockfile. Remove or change an override only after the owning direct
dependency declares a safe compatible range and integration coverage passes.

## Build Dependency Override

`esbuild` は `0.28.2` に固定します。`tsup@8.5.1` の `^0.27.0` は
Windows 開発サーバーのパス探索問題（GHSA-g7r4-m6w7-qqqr）の修正版を含まないためです。
既存の `tsx` と Vite は `0.28.x` を許容しますが、`tsup` の宣言範囲は越えるため、
型検査・全テスト・ビルド・配布物 smoke で互換性を検証します。実行時の provider 制御、
レビュー要件、セキュリティ例外の期限は変更しません。上流の `tsup` が安全な範囲を宣言し、
同じ検証を通過した場合にのみ、この override を削除します。

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
npm ls @modelcontextprotocol/sdk @hono/node-server express ignore ws zod
npm run typecheck
npm test
npm run lint
npm run check:public
npm run verify:dist
git diff --check
```

The security scan is content-bound. From a clean exact-HEAD checkout, write the
derived report outside the repository, then pass the candidate, report,
existing public-history checkout, and the checksum-verified gitleaks executable
explicitly:

```bash
npm run security:export -- --output /absolute/private/tmp/candidate-export.json
npm run security:scan -- --candidate "$PWD" --export-report /absolute/private/tmp/candidate-export.json --public-repo /absolute/path/to/public-history --gitleaks-bin /absolute/path/to/pinned/gitleaks
```

The gitleaks version and archive and executable SHA-256 values are pinned in
`security/oss-security-policy.json`. The export refuses a dirty worktree,
symlinked tracked file, in-repository report path, or existing report target.

Lifecycle implementation tests must use deterministic GitHub and push fakes;
dependency verification must not contact a live repository or mutate GitHub.
A new production advisory, license incompatibility, unexplained package,
expired exception, or unreviewed lockfile churn blocks release preparation.
