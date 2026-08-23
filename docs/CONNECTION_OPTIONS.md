# Connection Boundary

The documented ChatGPT connection for Chat Pro Repository MCP is OpenAI Secure
MCP Tunnel. The server itself remains reachable only on loopback:

```text
health: http://127.0.0.1:8789/health
MCP:    http://127.0.0.1:8789/mcp
```

## Why The Tunnel Is Separate

The local server owns repository policy and tools. The OpenAI-managed tunnel
owns authenticated transport from ChatGPT to loopback. Keeping these roles
separate means:

- the repository does not store tunnel credentials;
- no MCP tool can configure or widen network ingress;
- tunnel activation does not register roots or grant task authority; and
- stopping either component closes the connection without deleting source or
  lifecycle state.

## Activation

1. Start the local server with `npm run mcp`.
2. Verify `curl http://127.0.0.1:8789/health`.
3. Activate a Secure MCP Tunnel in the OpenAI workspace with the local target
   `http://127.0.0.1:8789/mcp`.
4. Create the ChatGPT app using the resulting Tunnel ID.

There is intentionally no repository script that accepts a tunnel API key,
prints a remotely reachable MCP endpoint, or starts a third-party ingress
process. See [Connect ChatGPT](CHATGPT_CONNECT.md) for app creation.

## Failure Isolation

- Local health down: diagnose or restart the MCP server.
- Local health up but app unavailable: inspect the Secure MCP Tunnel and app
  association in the OpenAI workspace.
- App connected but a tool is denied: inspect repository policy, task
  authority, exact-state bindings, and owner approval. Network connectivity
  does not imply tool authorization.
