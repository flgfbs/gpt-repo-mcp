# Glossary

| Term | Meaning |
| --- | --- |
| Registered repository | Canonical local root added by the owner CLI. MCP tools cannot add one. |
| `repo_id` | Stable public id for an owner-registered repository or a server-issued task repository. It is not a path. |
| Repository mode | Maximum configured `read`, `write`, or `ship` capability. |
| `task_id` | Stable caller/server binding for one isolated lifecycle task. |
| Task authority | Narrow `inspect`, `implement`, or `ship` authority fixed at task open. |
| Task branch/worktree | Server-derived branch and isolated working directory owned by one task. |
| `operation_id` | Caller-generated stable id used for exact replay protection and durable receipts. |
| HEAD/tree | Exact Git commit and content-tree object ids used to reject stale state. |
| Artifact | Server-owned durable evidence exposed only by opaque `artifact_id`, metadata, and bounded byte reads. |
| Effect state | Durable classification of an external attempt, such as no change, confirmed push, or queryable effect. |
| Merge gate | Read-only, expiring, content-bound manifest of exact PR/HEAD/tree/method/CI/review state. |
| Owner approval | Mode-0600, one-time approval created only by `chat-pro-repo approve-merge --gate-id <opaque-id>`. |
| Secure MCP Tunnel | OpenAI-managed transport between ChatGPT and the loopback MCP endpoint. It grants no repository authority. |
| Semantic Worker | Future provider-neutral external implementation-worker contract; not an embedded model or credential integration. |
| `ship` | Permission for bounded local Git and task GitHub lifecycle, not release or deployment. |
