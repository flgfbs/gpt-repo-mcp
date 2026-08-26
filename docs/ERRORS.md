# Errors, Effects, And Recovery

Chat Pro Repository MCP returns sanitized structured errors. Errors do not
include secrets, absolute owner paths, environment values, stack traces, raw
command output, or credential material.

## Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized message",
    "retryable": false,
    "diagnostics": {}
  }
}
```

Diagnostics are optional and bounded. They may include repo-relative paths,
expected/current object ids, safe counts, warning codes, or a recovery hint.

## Common Local Categories

| Code or category | Meaning |
| --- | --- |
| `UNKNOWN_REPO` | `repo_id` is not owner registered. |
| `ABSOLUTE_PATH_REJECTED` / `PATH_TRAVERSAL_REJECTED` | A path was not safe and repo-relative. |
| `SYMLINK_ESCAPE_REJECTED` | Canonical resolution left the registered root. |
| `SECRET_CANDIDATE_BLOCKED` | A path or content looked credential-sensitive. |
| `SIZE_LIMIT_EXCEEDED` | A configured or contract byte/count bound was exceeded. |
| `WRITE_DISABLED` / write-policy codes | Repository write policy did not admit the target. |
| `OPERATIONS_DISABLED` / Git-policy codes | Local Git, validation, or cleanup policy was not enabled. |
| `CODEX_RUN_FINALIZE_DISABLED` | The separate default-off exact Delegation v3 run finalizer capability is not enabled for this repository. |
| `LIFECYCLE_POLICY_DENIED` | The repository or task does not admit the requested lifecycle authority; local-only tasks use this for every remote or GitHub operation. |
| `RUNNER_PROVIDER_UNAVAILABLE` | No owner-supplied managed continuation connection is configured. |
| `RUNNER_LOCK_ACTIVE` | The selected run or private thread already has an in-flight turn. |
| `GIT_HEAD_MISMATCH` | Current HEAD differs from the exact expected HEAD. |
| `GIT_STAGED_PATHS_MISMATCH` | Actual staged paths differ from the reviewed set. |
| `VALIDATION_DISABLED` / `VALIDATION_PROFILE_UNAVAILABLE` | The requested named validation route is not admitted. |
| `VALIDATION_ERROR` | Strict input validation failed. |
| `INTERNAL_ERROR` | An unexpected implementation failure was sanitized. |

Lifecycle services may add stable codes for task binding, operation replay,
external contact, CI/review staleness, artifact identity, gate expiry, or
approval consumption. Treat the returned code and `retryable` field as the
contract; do not infer authority from an error message.

`LIFECYCLE_POLICY_DENIED` is not a prompt to invent a Git remote. For a
repository without GitHub authority, continue through local validation, review,
commit, close, and cleanup. External lifecycle requires a separate owner
configuration decision.

## Stale State Is A Fresh Read, Not A Bypass

When expected file bytes, HEAD, tree, review thread time, CI snapshot, manifest,
or approval no longer match:

1. stop the attempted mutation;
2. read the authoritative current state;
3. re-run the relevant validation/review if the state changed; and
4. construct a new exact operation only when current policy admits it.

Do not remove expected-state fields, substitute another task, or reuse an old
approval.

## Interrupted External Effects

An error or missing response after remote contact does not prove that nothing
happened. Push persists pre-contact and post-contact evidence and classifies the
effect as `no_change`, `pushed`, or `queryable_effect`. GitHub mutations retain
operation-bound receipts and support authoritative status/read-back.

Recovery sequence:

```text
same task + original operation id
  -> task/receipt status
  -> authoritative remote or GitHub read-back
  -> confirmed no effect, confirmed effect, or unresolved queryable effect
```

Replay only when the service recognizes the exact idempotent operation and
current state admits it. If state remains incomplete or uncertain, preserve the
receipt and stop rather than generating a second effect.

Managed-agent continuation is stricter after App Server contact. If
`turn/start` times out, disconnects, or returns an invalid acknowledgement, the
service records `UNKNOWN_AFTER_CONTACT` and an in-flight private attempt, then
returns `EXTERNAL_EFFECT_UNKNOWN`. Inspect the same run with `repo_agent_runs`;
do not repeat the instruction with either the same or a new `operation_id`.

## Merge Recovery

Owner approval is content-bound, unexpired, and one-time. If merge returns no
normal response, call `repo_post_merge_readback` or the bound PR status tool.
Do not prepare a new approval until the original merge effect and approval
consumption state are known.

Changed HEAD/tree, PR, review, CI, merge method, deletion choice, manifest
digest, or expiration requires a newly prepared gate and a new owner decision.
