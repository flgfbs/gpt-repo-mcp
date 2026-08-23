# Tool Surface

Chat Pro Repository MCP publishes exactly 63 tools in the order below. The
first 46 are inherited unchanged in order; the final 17 are the task and GitHub
lifecycle package. No aliases are registered.

## Tool Groups

- 1-14: repository discovery, code intelligence, diagnostics, and review
- 15-24: local Git, commit, recovery, and cleanup
- 25-35: product context, planning, work inventory, and delegation
- 36-39: transactional patchsets
- 40-46: validation, work sessions, direct writes, and handoff
- 47-63: task worktrees, Git/GitHub/CI/review/merge lifecycle

MCP annotations describe expected effects; they do not grant authority.
External reads and writes have `openWorldHint: true`. Lifecycle mutations are
operation-bound and idempotent at the exact contract boundary. Local policy,
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

### `repo_prepare_patchset`

36. Prepare an atomic create, modify, edit, delete, or rename manifest.

### `repo_apply_patchset`

37. Apply a prepared patchset with stale-state guards and rollback guidance.

### `repo_review_patchset`

38. Review patchset, ledger, and Git state without mutation.

### `repo_rollback_patchset`

39. Roll back an eligible unchanged, uncommitted applied patchset.

### `repo_validate`

40. Run a named allowlisted validation profile without arbitrary shell input.

### `repo_start_work_session`

41. Start content-free local progress state for a focused work slice.

### `repo_update_work_session`

42. Append bounded decisions, paths, evidence, risks, status, or next action.

### `repo_current_work_session`

43. Read the current or selected work-session state.

### `repo_write_file`

44. Create or precisely edit one policy-allowed repository file.

### `repo_write_changes`

45. Apply one cohesive, policy-allowed multi-file change pack.

### `repo_write_handoff`

46. Write a local-only ChatGPT handoff without Git mutation.

### `repo_task_open`

47. Idempotently open a server-bound task from exact base branch, commit, tree,
authority, goal, and branch slug. This is a local non-destructive mutation.

### `repo_task_status`

48. Read the task binding, current HEAD/tree, artifacts, and cleanup eligibility.

### `repo_task_close`

49. Idempotently close an exact unchanged task as `completed`, `blocked`,
`abandoned`, or `superseded`.

### `repo_task_cleanup`

50. Idempotently delete eligible closed server-owned task workspace resources
and optionally its artifact set while retaining a receipt.

### `repo_artifact_read`

51. Read at most 65,536 bytes from an opaque artifact id at a byte offset; no
path is accepted.

### `repo_remote_status`

52. Read exact remote base/task refs and their relationship to the bound task
HEAD/tree. This is an open-world read with an operation id.

### `repo_write_push`

53. Idempotently fast-forward push the exact server-owned task branch through
the fixed Git boundary. Requires `ship`; force is impossible.

### `repo_pr_create_or_update`

54. Idempotently create or update the task-derived pull request while keeping
it Draft. Requires `ship`.

### `repo_pr_status`

55. Read current GitHub pull-request state for the exact task.

### `repo_pr_review_threads`

56. Read bounded paginated review threads for the task pull request.

### `repo_write_pr_reply`

57. Idempotently post one operation-bound reply to an exact review thread.

### `repo_write_pr_resolve_thread`

58. Idempotently resolve an exact review thread at its expected update time.

### `repo_ci_status`

59. Read GitHub Actions runs and checks for the exact task HEAD/tree and return
a bound CI snapshot id.

### `repo_write_ci_retry_failed`

60. Idempotently retry only exact failed run ids from a bound CI snapshot.

### `repo_merge_gate_prepare`

61. Read fresh PR, review, CI, and Git state and return blockers or an expiring
exact merge manifest plus the owner CLI command.

### `repo_write_merge`

62. Idempotently consume one exact, unexpired, one-time owner approval and merge
the bound manifest.

### `repo_post_merge_readback`

63. Read authoritative post-merge PR, base-ref, task-ref, and commit state.

## Lifecycle Contract Pattern

Except for local task status and artifact paging, lifecycle calls bind task
identity and exact state. Mutating or external calls require a caller-generated
`operation_id`; external state operations also require the exact expected task
HEAD and tree as applicable. Inputs are strict: unknown fields, caller-selected
paths, arbitrary remote URLs, and arbitrary command arguments are rejected.

For end-to-end ordering, see [Write Workflows](WRITE_WORKFLOWS.md).
