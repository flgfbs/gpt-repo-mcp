# Setup And Operations

This guide installs Chat Pro Repository MCP, registers repositories, starts the
loopback service on port `8789`, activates OpenAI Secure MCP Tunnel, and covers
health, rollback, and uninstall.

## Prerequisites

- Node.js 20 or newer
- Git
- `gh` installed and authenticated for GitHub lifecycle tools
- an OpenAI workspace where Secure MCP Tunnel and custom ChatGPT apps are
  available

The MCP server never reads credentials. `gh` owns its installed authentication,
and Secure MCP Tunnel credentials remain in the OpenAI-managed tunnel runtime.

## Install

From a trusted checkout:

```bash
npm ci
npm run build
cp config.example.json config.local.json
```

`config.example.json` is intentionally empty. `config.local.json` is local-only
and must not be committed.

## Register A Repository

Use the owner CLI through the package shortcuts:

```bash
npm run add -- /path/to/your/repo --mode <mode>
npm run list
npm run check:config
```

Replace `<mode>` with explicit `read`, `write`, or `ship`:

- `read` enables bounded inspection;
- `write` additionally enables policy-checked edits; and
- `ship` additionally admits local Git and task-bound GitHub lifecycle work.

The CLI resolves and records the canonical root. It rejects duplicate ids and
roots. No MCP tool can register a root or change its mode.

To choose stable labels:

```bash
npm run add -- /path/to/your/repo --mode ship --id project-id --name "Project Name"
```

Manual configuration remains possible for advanced operators, but the CLI is
recommended because it performs canonicalization and validation.

## Validate And Diagnose

```bash
npm run check:config
npm run doctor
```

Success means configuration is valid, required local executables are visible,
the loopback binding is usable, and no blocking diagnostic is reported. An
empty starter config can validate, but the doctor reports that no repository is
registered.

## Start, Health, And Stop

Start the development runtime with the local configuration and required port:

```bash
npm run mcp
```

After a build, the production entrypoint can be started explicitly:

```bash
CHAT_PRO_REPOSITORY_MCP_CONFIG=./config.local.json PORT=8789 npm start
```

The service binds to `127.0.0.1`, exposes MCP at
`http://127.0.0.1:8789/mcp`, and exposes local health at:

```bash
curl http://127.0.0.1:8789/health
```

Success is an HTTP 200 JSON response with `ok: true`. Stop the foreground
server with `Ctrl-C`. Stopping the process does not remove repository
registration, tasks, receipts, or approvals.

## Activate OpenAI Secure MCP Tunnel

Tunnel activation is an OpenAI workspace operation, not a script in this
repository:

1. Keep `npm run mcp` running and confirm local health.
2. In the OpenAI workspace administration surface, create or activate a Secure
   MCP Tunnel that forwards to `http://127.0.0.1:8789/mcp`.
3. Keep the tunnel runtime active on the same machine as the loopback server.
4. Record the returned `tunnel_...` identifier in the workspace connection
   surface, not in this repository.
5. Follow [ChatGPT Connection](CHATGPT_CONNECT.md) to create the app.

The supported public documentation covers Secure MCP Tunnel activation only.
It does not expose the loopback server through a public URL.

## First ChatGPT Check

After creating the app and refreshing its tools, ask:

```text
Use Chat Pro Repository MCP. Which repositories can you access?
```

The answer should contain only registered `repo_id` values. Then request a
bounded project brief or tree read before authorizing changes.

## Owner Merge Approval

When `repo_merge_gate_prepare` reports an eligible exact-head gate, it prints:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

Run that command in the owner terminal. Verify the displayed repository, task,
pull request, exact HEAD/tree, method, branch-deletion choice, review/CI state,
digest, and expiration before confirming. The resulting approval is mode 0600,
expires with the gate, and can be consumed once.

## Rollback And Uninstall

To roll back access without deleting repository data:

1. stop the MCP server;
2. stop or deactivate its Secure MCP Tunnel;
3. disable or remove the ChatGPT app;
4. unregister each root with `npm run remove -- <repo_id>`; and
5. run `npm run list` to confirm the registry is empty.

Unregistering a root does not delete the repository. Before removing this
checkout, preserve any desired local configuration or lifecycle evidence in a
secure location. Remove the checkout only after confirming no task worktree or
unconsumed owner approval is still needed.

If the CLI was globally linked, remove that link using the package manager's
normal unlink operation. No uninstall step should delete a registered source
repository.

## Updating

Update only from a trusted revision, then review dependency and public-contract
changes:

```bash
npm ci
npm run build
npm run check:config
npm run typecheck
npm test
npm run lint
npm run check:public
npm run security:scan
npm run verify:dist
```

Do not use `npm audit fix --force`. See
[Dependency Security](DEPENDENCY_SECURITY.md) and [Migration](MIGRATION.md).

## Troubleshooting

- Health fails: confirm the server is running and port `8789` is free.
- Tools are absent in ChatGPT: confirm the Tunnel ID and refresh app metadata.
- `UNKNOWN_REPO`: run `npm run list`; only the owner CLI can register the root.
- GitHub reads fail: run `gh auth status` in the owner terminal; do not paste
  authentication output or tokens into ChatGPT.
- A state-bound call is stale: read current task/GitHub state and prepare a new
  exact operation rather than weakening the expected state.
- A merge approval is rejected: prepare a fresh gate; approvals cannot be
  edited, replayed, or transferred to a changed manifest.
