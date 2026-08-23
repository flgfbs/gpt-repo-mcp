# Changelog

Notable public changes to Chat Pro Repository MCP are recorded here.

## Unreleased

### Added

- Seventeen task and GitHub lifecycle tools appended after the inherited 46,
  producing an exact 63-tool surface with no aliases.
- Server-bound task worktrees, opaque lifecycle artifacts, exact-state remote
  observation, fixed-argument non-force push, Draft pull requests, review and
  CI handling, exact merge-gate preparation, one-time owner CLI approval, and
  post-merge read-back.
- OpenAI Secure MCP Tunnel as the documented ChatGPT connection path.

### Changed

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
