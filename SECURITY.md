# Security

Chat Pro Repository MCP is a local-first MCP server for explicitly registered
repositories. The detailed trust boundaries, threat model, GitHub lifecycle,
and merge-approval rules are in [docs/SECURITY.md](docs/SECURITY.md).

## Supported Versions

This project is pre-1.0. Security fixes are handled on the maintained public
branch until a formal version policy is published.

## Reporting A Vulnerability

Report vulnerabilities privately through GitHub Security Advisories when
available. Otherwise contact the maintainer through a private channel before
public disclosure. Do not include real credentials, private keys, tokens,
repository contents, local paths, Tunnel IDs, or account data in a public issue.

## Security Scope

Security-sensitive surfaces include registered-root and path enforcement,
secret blocking, local writes and Git, task worktrees, operation replay,
fixed-argument push, the strict GitHub adapter, artifact access, Secure MCP
Tunnel connectivity, and the exact owner-approved merge gate.

The server exposes no shell, arbitrary command, arbitrary Git, arbitrary GitHub
API, credential-reading, release, or deployment tool. Push and merge exist only
inside the documented `ship` lifecycle: push is exact-branch and non-force;
merge consumes one exact, unexpired owner CLI approval.

## Disclosure

Please allow reasonable investigation and remediation time before public
disclosure. Reproduction steps should use synthetic data.
