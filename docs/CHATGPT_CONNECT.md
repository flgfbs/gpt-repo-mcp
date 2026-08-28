# Connect ChatGPT

ChatGPT connects to Chat Pro Repository MCP through an OpenAI Secure MCP Tunnel.
The MCP service remains on loopback at `127.0.0.1:8789`.

## 1. Start And Verify The Local Server

```bash
npm run mcp
curl http://127.0.0.1:8789/health
```

Continue only when health returns HTTP 200 with `ok: true`.

## 2. Activate Secure MCP Tunnel

In the OpenAI workspace administration surface, activate a Secure MCP Tunnel
whose local target is:

```text
http://127.0.0.1:8789/mcp
```

Keep the tunnel runtime active on the server machine. Treat its `tunnel_...`
identifier as workspace configuration. Do not commit it, a tunnel credential,
or account data to this repository.

## 3. Create The ChatGPT App

In a ChatGPT workspace where Developer Mode and custom MCP apps are enabled:

1. Open workspace settings and the app/connector creation surface.
2. Choose to create a custom MCP app.
3. Name it `Chat Pro Repository MCP`.
4. Select **Tunnel** as the connection type.
5. Select or enter the activated `tunnel_...` identifier.
6. Save the app and refresh its tool metadata.
7. Confirm that exactly 66 tools are listed.

The exact workspace labels may evolve, but the connection must remain a Secure
MCP Tunnel to the loopback MCP endpoint.

## 4. Choose Host Confirmation Behavior

ChatGPT may offer per-action confirmation or **Allow all actions**. Either can
be used according to workspace policy.

**Allow all actions does not broaden server authority.** It cannot add roots,
enable writes, grant task `ship` authority, read credentials, bypass expected
HEAD/tree checks, permit force push, or create an owner merge approval. The
server independently validates every call.

## 5. Verify The App

Ask:

```text
Use Chat Pro Repository MCP. Which repositories can you access?
```

Only owner-registered roots should be returned. For a safe first read:

```text
Use Chat Pro Repository MCP. Give me a project brief for <repo_id>.
```

For lifecycle work, confirm that the task authority matches the request before
allowing a push or pull-request mutation.

## Disconnect

Disable or remove the ChatGPT app, deactivate the Secure MCP Tunnel, and stop
the local server. This does not delete repositories or task artifacts. Use the
owner CLI separately if repository registration should also be removed.
