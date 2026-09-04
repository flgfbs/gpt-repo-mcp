# Tool Surface

Chat Pro Repository MCP publishes exactly 67 tools in the order below. The
first 47 are the preserved canonical local prefix, position 48 is managed-agent
continuation, and the final 19 are the task and optional GitHub lifecycle
package. No aliases are registered.

## Tool Groups

- 1-14: repository discovery, code intelligence, diagnostics, and review
- 15-24: local Git, commit, recovery, and cleanup
- 25-36: product context, planning, work inventory, and delegation
- 37-40: transactional patchsets
- 41-47: validation, work sessions, direct writes, and handoff
- 48: managed Codex App Server continuation
- 49-67: task worktrees, exact-head Fable review, admission, and Git/GitHub/CI/review/merge lifecycle

MCP annotations describe expected effects; they do not grant authority.
External reads and writes have `openWorldHint: true`. Lifecycle mutations are
operation-bound. They are idempotent at the exact contract boundary except for
`repo_run_fable_review`, whose one provider-contact allowance makes replay an
explicit error. Local policy,
task authority, exact state, and owner approval still decide admission.

## Canonical Ordered Catalog

### `repo_list_roots`

1. List registered repository ids and display names without reading source.

### `repo_policy_explain`

2. Explain effective read, write, cleanup, validation, and Git policy.

### `repo_last_write`

3. Return safe metadata for the latest local write or operation.

### `repo_operation_ledger`

4. Inspect bounded historical operation receipts.

### `repo_tree`

5. Browse a bounded repository tree without reading file contents.

### `repo_search`

6. Search bounded text or code under repository policy.

### `repo_fetch_file`

7. Read one known file or line range.

### `repo_read_many`

8. Read a bounded known set of files or globs.

### `repo_context_map`

9. Map file-level imports, dependents, entrypoints, and affected tests.

### `repo_symbol_context`

10. Gather symbol definitions, references, calls, implementations, and tests.

### `repo_code_index`

11. Inspect or explicitly manage the optional code index.

### `repo_failure_diagnose`

12. Normalize saved validation failures without running commands.

### `repo_semantic_review`

13. Review current changes for evidence-based semantic risk.

### `repo_ship_review`

14. Combine Git, validation, semantic, and delegation readiness evidence.

### `repo_git_status`

15. Read branch, HEAD, cleanliness, and changed-path status.

### `repo_git_diff`

16. Read bounded raw Git diff content.

### `repo_git_review`

17. Review current Git state and return exact commit or recovery guidance.

### `repo_git_restore_paths`

18. Restore explicit reviewed unstaged tracked paths.

### `repo_write_stage`

19. Stage an exact reviewed pathset locally.

### `repo_write_unstage`

20. Unstage an exact reviewed pathset locally.

### `repo_write_commit`

21. Commit the exact already-staged pathset at the expected HEAD.

### `repo_write_stage_commit`

22. Apply the canonical reviewed stage-and-commit payload atomically.

### `repo_write_recover`

23. Apply exact composite unstage, restore, or cleanup recovery.

### `repo_cleanup_paths`

24. Delete explicit reviewed generated/local paths allowed by cleanup policy.

### `repo_project_brief`

25. Summarize repository-owned product context and technical entrypoints.

### `repo_task_inventory`

26. Find bounded TODO, FIXME, checkbox, roadmap, or backlog evidence.

### `repo_decision_memory`

27. Read architecture rationale, conventions, and historical decisions.

### `repo_change_plan`

28. Plan an already chosen implementation goal without selecting new work.

### `repo_prepare_codex_task`

29. Preview a product-grounded Delegation v3 task artifact.

### `repo_write_codex_task`

30. Write bound delegation artifacts without starting a worker.

### `repo_agent_runs`

31. Inspect bounded external-worker lifecycle and interaction state.

### `repo_write_agent_reply`

32. Answer the exact current structured worker questions.

### `repo_codex_review`

33. Verify a worker result against task, scope, Git, and evidence.

### `repo_write_codex_review`

34. Persist a state-bound qualitative review attestation.

### `repo_write_integration_review`

35. Bind several currently attested runs into one exact integration pathset.

### `repo_finalize_codex_run`

36. Finalize one exact terminal technical Delegation v3 run without generic
shell authority. The server rechecks the manifest-authorized pathset, exact
source hashes, Git binding, fixed provider-free validation, and terminal run
state before creating one unsigned local commit. It then exports and verifies
one committed-source archive, writes `RESULT.json`, records terminal runner
state, and performs post-operation read-back. It never pushes or contacts
GitHub, a model, or another repository.
It is additionally gated by the default-off per-repository
`operations.codex_run_finalize_enabled` capability; generic `ship` operations
may remain disabled.

### `repo_prepare_patchset`

37. Prepare an atomic create, modify, edit, delete, or rename manifest.

### `repo_apply_patchset`

38. Apply a prepared patchset with stale-state guards and rollback guidance.

### `repo_review_patchset`

39. Review patchset, ledger, and Git state without mutation.

### `repo_rollback_patchset`

40. Roll back an eligible unchanged, uncommitted applied patchset.

### `repo_validate`

41. Run a named allowlisted validation profile without arbitrary shell input.

### `repo_start_work_session`

42. Start content-free local progress state for a focused work slice.

### `repo_update_work_session`

43. Append bounded decisions, paths, evidence, risks, status, or next action.

### `repo_current_work_session`

44. Read the current or selected work-session state.

### `repo_write_file`

45. Create or precisely edit one policy-allowed repository file.

### `repo_write_changes`

46. Apply one cohesive, policy-allowed multi-file change pack.

### `repo_write_handoff`

47. Write a local-only ChatGPT handoff without Git mutation.

### `repo_continue_agent_run`

48. Start one next turn on the private session of an existing managed Codex App
Server run. The input binds the existing task repository, run, operation id,
observed run revision, and bounded instruction. It accepts no thread, model,
machine, repository-path, sandbox, approval, binding, idempotency, HEAD, or tree
override. `repo_agent_runs` remains the public status tool, and
`repo_write_agent_reply` remains the path for structured awaiting-input
questions. After uncertain `turn/start` contact the operation is no-replay.

### `repo_task_open`

49. Idempotently open a server-bound task from exact base branch, commit, tree,
authority, goal, and branch slug. This is a local non-destructive mutation.

### `repo_task_status`

50. Read the task binding, current HEAD/tree, artifacts, and cleanup eligibility.

### `repo_task_close`

51. Idempotently close an exact unchanged task as `completed`, `blocked`,
`abandoned`, or `superseded`.

### `repo_task_cleanup`

52. Idempotently delete eligible closed server-owned task workspace resources
and optionally its artifact set while retaining a receipt.

### `repo_artifact_read`

53. Read at most 65,536 bytes from an opaque artifact id at a byte offset; no
path is accepted.

### `repo_run_fable_review`

54. Run at most one exact-head independent review through the installed typed
Fable launcher. The input requires an active `implement` or `ship` task repo,
task id, exact base commit/tree, exact current HEAD/tree, operation id, review
kind, and canonical scope. The server creates the packet and lineage, verifies a
clean worktree and every provider-free gate before contact, selects primary
`FABLE` at `MAX`, and rejects caller-supplied commands, paths, roots, environment,
provider model slugs, routes, credentials, packets, prompts, retry, fallback,
reroute, tools, MCP, plugins, subagents, reuse, and continuation. The action is
open-world and deliberately non-idempotent: duplicate operations and contacted,
unknown, or orphaned epochs are no-replay. It returns only sanitized review,
receipt digest, provider-contact/effect, model-class/reasoning, packet, target,
scope, and lineage evidence. A focused rereview requires a retained `REVISE` or
`BLOCK` artifact and a changed exact target.

### `repo_remote_status`

55. Read exact remote base/task refs and their relationship to the bound task
HEAD/tree. This is an open-world read with an operation id.

### `repo_write_push`

56. Idempotently fast-forward push the exact server-owned task branch through
the fixed Git boundary. Requires `ship`; force is impossible.

### `repo_pr_create_or_update`

57. Idempotently create or update the task-derived pull request while keeping
it Draft. Requires `ship`.

### `repo_pr_status`

58. Read current GitHub pull-request state for the exact task.

### `repo_pr_review_threads`

59. Read bounded paginated review threads for the task pull request.

### `repo_write_pr_reply`

60. Idempotently post one operation-bound reply to an exact review thread.

### `repo_write_pr_resolve_thread`

61. Idempotently resolve an exact review thread at its expected update time.
Requires passed exact validation and either corrected-head evidence or a durable
same-head reply followed by fresh exact validation.

### `repo_ci_status`

62. Read GitHub Actions runs and checks for the exact task HEAD/tree and return
a bound CI snapshot id.

### `repo_write_ci_retry_failed`

63. Idempotently retry only exact failed run ids from a bound CI snapshot.

### `repo_merge_gate_prepare`

64. Read fresh PR, review, CI, and Git state and return blockers or an expiring
exact merge manifest plus the owner CLI command.

### `repo_write_merge`

65. Idempotently consume one exact, unexpired, one-time owner approval and merge
the bound manifest.

### `repo_post_merge_readback`

66. Read authoritative post-merge PR, base-ref, task-ref, and commit state.

### `repo_task_admission`

67. Read whether an expected exact task is absent, exactly matches its own active
binding, or conflicts with its requested-task state. Unrelated active tasks do
not deny an exact match. It is closed-world, read-only, and accepts no operation
id or mutation request.

## Lifecycle Contract Pattern

Except for local task status, task admission, and artifact paging, lifecycle
calls bind task identity and exact state. Mutating or external calls require a
caller-generated `operation_id`; external state operations also require the
exact expected task HEAD and tree as applicable. Managed-agent continuation is
the explicit exception to HEAD/tree input because the child may have changed
its own worktree; it binds task/run/revision and private session identity
instead. Inputs are strict: unknown fields, caller-selected paths, arbitrary
remote URLs, and arbitrary command arguments are rejected.
`repo_run_fable_review` binds both base and current Git objects and is the only
non-idempotent lifecycle action; its operation id and lineage are replay guards,
not retry authority.

For end-to-end ordering, see [Write Workflows](WRITE_WORKFLOWS.md).
