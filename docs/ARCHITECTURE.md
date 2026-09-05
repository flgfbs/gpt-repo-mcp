# Architecture

Chat Pro Repository MCP is a contract-first, local-first MCP server. The public
surface is a closed catalog of exactly 67 tools. Task/worktree lifecycle is
local; only the GitHub-enabled external subset is open-world because it
contacts the configured Git remote and GitHub.

## Contract-First Tool Path

Every tool follows one path:

```text
src/contracts/*.contract.ts
  -> src/tools/contracts.ts
  -> src/tools/packages/*.ts
  -> src/tools/registry.ts
  -> src/register.ts + src/tools/define-tool.ts
  -> src/tools/handlers/*.ts
  -> src/services/*.ts
```

- Contract modules own strict Zod input/output schemas.
- `src/tools/contracts.ts` is the only tool-name-to-contract map.
- Package modules attach title, description, annotations, tier, capability, and
  thin handler.
- `src/tools/registry.ts` rejects duplicates, missing definitions, and unknown
  definitions, then constructs the canonical 67-tool order.
- `src/register.ts` iterates that registry and registers each tool through
  `src/tools/define-tool.ts`.
- Handlers parse, call one runtime/service boundary, audit safe metadata, and
  return a shared envelope.
- Services own policy, state, Git, filesystem, artifacts, and external effects.

The first 47 local names are preserved exactly. Managed-agent continuation is
position 48, followed by the 19 lifecycle names listed in
[Tool Surface](TOOL_SURFACE.md); compatibility aliases are not registered.

## Runtime Construction Seams

The server construction root creates a `RuntimeContext` and passes it to every
registered handler. Its dependencies are deliberately explicit:

- `RootRegistry` resolves registered repository ids to canonical roots and
  policy;
- optional code intelligence is injected behind its client factory;
- `AgentContinuationRuntime` is injected behind the one continuation handler;
  default construction supplies a lazy local App Server control connection;
- `LifecycleRuntime` is the strict handler boundary for the task and GitHub lifecycle tools;
- `ManagedFableReviewRuntime` is the separate one-shot exact-head review boundary;
- task-state/worktree storage owns task bindings and terminal state;
- the artifact store owns content-addressed bytes and opaque public ids;
- the optional Git push boundary accepts a fixed argument shape for the
  server-owned task branch only; and
- the optional `GitHubAdapter` owns repository, pull-request, CI, review, merge,
  and post-merge operations using installed `gh` fixed subcommands and JSON.

Production wiring uses the real fixed boundaries. Tests inject deterministic
fakes and make no live GitHub contact. Neither interface exposes an arbitrary
command, URL, repository selector, branch selector, or credential value.

The continuation runtime lazily connects to the existing owner Codex App Server
Unix control socket only when the continuation tool is called. It validates an
owner-only, same-user, non-symlink socket and parent directory, rejects writable
or symlinked ancestors, revalidates socket identity after connection, initializes one
JSON-RPC connection, and calls `thread/read`, `thread/resume`, and `turn/start`
without model, cwd, sandbox, approval, or machine overrides. It requires the
returned thread repository and provider to match the private run session, while
deliberately not requiring the current worktree HEAD or tree to equal an earlier
baseline. Startup does not contact, spawn, configure, or authenticate a provider.
The internal event sink settles the existing run status; there is no second
status system.

If a restart leaves an exact persisted App Server turn id in an in-flight
attempt, the same continuation boundary performs a query-only `thread/read`
with turns included. It rebinds the sink only when that id is unique and latest,
settles an already-terminal turn through the existing status machinery, and
never resumes or starts a replacement turn. Server requests on the bridge
connection are always resolved: approvals receive protocol-valid least-authority
negative results, unsafe questions receive empty answers, and other methods
receive bounded JSON-RPC errors.

Initial execution is owned by the separate `owner-agent-runner` process, not by
the HTTP MCP server. It rehydrates open task registrations, scans only exact
admitted `codex_app_server` queue entries, and reuses the existing immutable
dispatch and launch-intent boundary. One accepted launch calls `thread/start`
with the canonical task root, `approvalPolicy: never`, and the workspace-write
sandbox, verifies the returned root/provider/model and network-disabled sandbox,
then durably binds one `turn/start`. The returned model/provider are observed and
persisted; no model slug, repository identity, user path, or thread id is built
into product source.

The process exposes no HTTP, MCP, registration, or remote-control endpoint. It
retains the originating App Server connection only for fail-closed server
requests and terminal delivery. After restart it queries `thread/read` only when
an exact in-flight turn id is already durable; it never calls `thread/start`,
`thread/resume`, or `turn/start` as recovery. Missing or ambiguous effect evidence
remains no-replay.

## Local Repository Plane

The root registry is the sole repository admission boundary. Explicit roots
are canonicalized directly; owner-configured project roots expand read-only to
their direct, real child directories that are exact standalone Git worktree
roots. Linked worktree and submodule `.git` indirection files are not admitted.
Explicit repository entries override a discovered child root; a project root
inside an explicit repository, an ambiguous id, or a project-root overlap fails
closed. Sandboxed path
resolution canonicalizes each target under its root, applies ignore and secret
classification, rejects traversal and symlink escape, and enforces size limits.

Write policy, operations policy, validation profiles, expected file bytes,
expected HEAD, exact staged paths, and review evidence are checked in services,
not trusted from host confirmation or model reasoning.

## Task And Worktree Plane

A task manifest binds:

```text
task id + base repo + base branch + base commit + base tree
+ authority + exact goal + branch slug
```

The server derives a task repository id, task branch, and isolated worktree.
The task cannot escape its registered base repository or increase its bound
authority. State transitions are open -> closed -> cleaned; cleanup is limited
to server-owned resources.

A lifecycle policy is either `local` or `github`. Both share task authority,
allowed base branches, worktree root, clean-base admission, concurrency, and
cleanup rules. The local form ends at reviewed local Git. The GitHub form adds
remote identity, repository identity, checks, merge method, and external-effect
policy. Legacy policy objects without a discriminator are parsed as GitHub
policies.

Managed-agent continuation reuses that same task identity and its existing
operation ledger. Private `runner.session.json` and `runner.attempt.json`
artifacts bind thread, turn index, and in-flight state. Generic repository reads
exclude them, and public MCP results contain neither App Server thread nor turn
identifiers. The in-flight attempt and operation contact state are crash-durable
before `turn/start`. The local connection buffers notification delivery until
the bridge has persisted accepted running state, then dispatches the buffered
events without waiting on the continuation's task/run locks. The sink advances
the existing status monotonically to a terminal revision. Turn-start barriers
on the shared connection serialize, and a terminal notification receives at
most one same-message local settlement retry. Once `turn/start` may
have been accepted, the operation is unknown/no-replay rather than retried under
a new id. A later operation may only query-reconcile an exact persisted turn id;
missing or ambiguous ids stay blocked, and missing status cannot make an old
result reviewable.

## Managed Fable Review Plane

`repo_run_fable_review` is a dedicated open-world, one-shot task operation; it is
not a generic runner writable-root exception. The handler delegates to
`ManagedFableReviewRuntime`, whose production adapter knows only the digest-pinned
installed typed launcher and an owner-only transport bundle root. No public input
can select an executable, path, root, environment, route, provider model, packet,
prompt, or credential.

The task lock covers exact-state admission through launcher response and receipt
read-back:

```text
active implement/ship task + exact clean base/HEAD/tree + canonical scope
  -> bounded exact diff + secret scan + immutable launcher/router check
  -> append-only lineage/epoch claim + exclusive packet/request read-back
  -> one typed PRIMARY FABLE/MAX invoke
  -> retained receipt/response binding read-back
  -> append-only contact/effect outcome + sanitized task artifact
```

The precontact operation may terminate with `provider_contact=NO`. Once invocation
may have crossed the contact boundary, missing or malformed evidence cannot be
collapsed into a local/provider-free failure: a known contact remains `YES` and
an ambiguous effect remains `UNKNOWN`. Contacted, unknown, or orphaned claims
block fresh-initial replay. A prior `NO` outcome alone leaves the explicit
one-contact allowance unconsumed. Focused rereview uses a distinct epoch under
the same server-derived lineage, requires retained `REVISE` or `BLOCK` evidence,
and binds the prior attempt plus a changed exact target.

The installed launcher remains responsible for its existing guards and exact
owner-only diagnostic, claim/lock, receipt, and binding
files. Repository MCP uses exclusive creation and exact read-back only; it has no
cleanup, chmod, replacement, or mutation path for pre-existing installed runtime
evidence or static launcher/router bytes. Tests inject the launcher boundary and
make zero live provider contacts.

管理アダプターは、pin 済み receipt に存在しない `PROVIDER_RETRY_LIMIT` を要求しません。
retry 禁止は返却 payload の `attestation.provider_retry` と
`attestation.provider_retry_limit` で厳密に確認し、receipt と公開結果の identity・
response binding・review record の照合は維持します。実アダプターを通す合成テストで
`PASS`・`REVISE`・`BLOCK` の保持と、不正な retry 証明の拒否を検証します。

新しい互換 candidate の採用経路は receipt v3、review record v2 と native な完全応答保存を要求します。
公開 payload の `response_retention` ラベルだけでは採用せず、固定 locator の
native store の `<attempt>.response`・`<attempt>.json` と、診断側の `receipt.json` を実際に読みます。
owner-only の親ディレクトリと通常ファイルを検査し、symlink・hardlink・mode違反・
不完全なUTF-8・未知キー・非正規JSON・bytes/hash/identityの不一致を拒否します。
3ファイルを二度読み、内容と配置の安定性、完全な4項目target、packet/scope、判定、
attempt/decision/priorの結合を照合します。既存のv2/v1履歴は別の本文欠落検査に残し、
新しい成功結果を旧versionへdowngradeして受理しません。
管理側は receipt 検証の前に、schema・秘密情報検査を通った応答候補を task runtime の
`fable-received` 内へ新規作成専用で保存し、同一バイトを読み戻します。候補には
operation・target・scope・packet・lineage と、受信した判定および応答本文だけを束縛し、
`UNVERIFIED_NOT_REVIEW_AUTHORITY` と明示します。raw stream、private prompt、
credential、任意の launcher フィールドは保存しません。候補保存はレビュー承認でも
再接触の許可でもありません。過去候補の読取りには現在の checkout の HEAD や clean 状態を要求しません。

`retained_read_back` を公開できるのは、応答本文の保存・読み戻し、receipt と本文の
hash・byte length・判定の一致、および最終 task artifact の保存・読み戻しがすべて成功した場合だけです。
成功の operation 終端は最終 artifact の読戻し後に行い、保存失敗を warning だけで成功扱いしません。
照合失敗時も保存済み候補は削除せず、接触済みを保持します。既存の失敗 operation は書き換えず、
本文のない歴史的 receipt から指摘本文や完了証拠を合成しません。

review record v2 は commit・tree・digest・target_scope_sha256 の4項目だけを
target に持ち、record 自体にも明示したscopeを要求します。両scopeと実際のpacket header・
HEAD・treeを照合します。旧v1の3項目targetは歴史的証拠の検査だけに使用します。

外側の launcher 実行期限は65分です。pin 済み primary router の provider 上限30分、
直列 route の1処理分に相当するキュー待ち30分、開始・終了処理5分を含めます。
provider 自身の30分制限や接触回数を増やすものではなく、無制限のキュー待ちも保証しません。
外側期限を超えた場合も再試行や履歴の消去は行いません。完全な応答から接触を確認できた場合は
`YES/contacted_incomplete` を保持し、証拠が不完全な場合は `UNKNOWN` のままとします。
この65分の上限は早期終了を防ぐための境界であり、不要な待機の解消証拠ではありません。
正当な provider の直列実行と、queue・lock・終了処理の遅延は別々に検証する必要があります。

本番アダプターは stdout の上限2 MiBとstderrの上限64 KiBを独立に確保します。
既存の汎用捕捉を利用する他の呼出しは、従来の共有上限を維持します。
stdoutが上限内の完全なUTF-8/JSONなら、timeout・signal・非ゼロ終了・stderrだけの切詰めが
あっても、終了状態による採用判定より先に管理ストアの保存フックへ渡します。
stdout自体の切詰め、UTF-8不正、JSON不正は、切り取ったprefixだけがJSONとして成立しても拒否します。
保存は既存のschema・秘密情報検査を通った候補だけに限定し、raw stdout/stderrは保存しません。
失敗した実行や切詰めを含む結果ではreceiptの採用処理へ進まず、独立レビュー完了にしません。
実際の子プロセス捕捉・本番アダプター・管理ストアを通すprovider-free回帰で、
stderrの前後両順序、timeout、signal、非ゼロ終了、不正・欠落出力を検証します。

受信 payload または review record で接触済みを観測した後は、外側の例外・不完全な結果・
矛盾する `NO` フィールドによって接触状態を巻き戻しません。矛盾した成功結果は採用せず、
`contacted_incomplete` として保存・終端します。接触を示す証拠がない不明結果は従来どおり
`UNKNOWN` のままであり、いずれも再実行を許可しません。

### 本文欠落の回復レビュー

回復対象は `STOP_MANAGED_RECEIPT_READBACK_FAILED` で終了した initial operation のうち、
旧 receipt 自体は FABLE/MAX の有効な REVISE を証明し、管理ストアに本文が存在しないものだけです。
receipt の判定 `VALID_REVIEW_RESULT` と管理 operation の `PARTIAL` は別の事実として保存し、
旧 v1 artifact・claim/outcome・operation は変更しません。本文の破損・読取拒否・保存拡張や
未知の隣接ファイルは「不在」に読み替えず停止します。
既知の別保存領域についても、同じ attempt に対応する binding・response・unavailable の
固定 locator を確認します。一つでも存在する場合や安全に調べられない場合は回復接触を拒否し、
その内容の読出し・削除・書換えは行いません。他 attempt の保存記録は探索しません。

回復入力は旧 artifact・operation・attempt・receipt hash を束縛します。サーバーは同じ task/base の
初回 lineage/epoch と元の request digest を再計算し、追加の初回 claim がすべて無接触で確定済みで
あることを確認します。変更後の全 task 差分を再審査し、旧指摘を復元したとも閉じたとも主張しません。
transport には既存の `FOCUSED_REREVIEW` と旧 attempt を渡しますが、
`MISSING_BODY_FULL_SCOPE_REEXAMINATION` と証拠 digest を明示します。

接触前に `fable-recoveries` の新規作成専用レコードへ旧証拠の digest・新 target/scope/packet を
保存・読戻しし、transport 準備後にも旧証拠を再読します。再実行防止のキーは旧 operation id で、
artifact の別名や新 operation id は追加接触の許可になりません。接触後の失敗・不明は消費済みのままです。
回復の公開証拠だけを v2 とし、旧判定と新判定を区別します。新応答にも既存の事前保存・receipt照合・
最終 artifact 読戻しを適用し、返却された prior attempt/decision の両方を照合します。

この製品契約だけでは、運用側の外部 packet gate、独立レビュー入場条件、runtime activation、
merge approval は満たされません。運用側が全差分の回復再審査を受理できなければ、初回レビューや
架空の指摘閉鎖に偽装せず、その能力境界で停止します。

## External Effect Plane

This plane exists only for a GitHub lifecycle policy. A local lifecycle is
rejected with `LIFECYCLE_POLICY_DENIED` before any adapter call. When enabled,
push and GitHub API work are separate seams:

```text
exact task state -> durable pre-contact record -> fixed external call
                 -> authoritative read-back -> durable effect classification
```

`repo_write_push` uses Git directly with a fixed argument vector, exact branch,
fast-forward-only policy, and no force. GitHub operations use `GitHubAdapter`
through `gh`. Mutating or external requests carry an operation id and exact task
state so an identical request can be recognized and stale requests fail closed.

When a process exits after contact but before a normal response, recovery reads
the durable contact record and authoritative remote state. It reports no
change, a confirmed effect, or a queryable/uncertain effect; it does not
silently replay.

## Merge Approval Plane

Merge preparation is read-only. It creates an expiring manifest binding the
repository, task, pull request, base and task branches, exact HEAD and tree,
merge method, mandatory remote-task-branch retention, CI runs, review threads,
timestamps, and manifest digest.

The owner CLI is the only approval writer:

```bash
chat-pro-repo approve-merge --gate-id <opaque-id>
```

The CLI resolves the content-addressed gate, displays its bound details,
requires owner confirmation, and writes a mode-0600 approval. Merge consumes
that approval once. Changed or expired bindings require a newly prepared gate
and a new owner decision.

## Artifact Strategy

Lifecycle services keep durable evidence outside normal source reads. Public
results contain opaque ids and hashes, not local paths. The single public
conversion seam resolves an `artifact_id` to internal storage identity;
callers cannot choose a filesystem location.

Artifacts hold task manifests, operation receipts, bounded validation logs,
large diffs, remote observations, push and pull-request evidence, review and CI
evidence, merge-gate evidence, merge receipts, and post-merge evidence.
`repo_artifact_read` streams bounded byte windows with a digest and EOF state.

## Transport Plane

The MCP HTTP service binds to loopback and is started on port `8789` by the
public package script. `/health` is a minimal local liveness endpoint and `/mcp`
is the Streamable HTTP endpoint. ChatGPT reaches it only through an activated
OpenAI Secure MCP Tunnel. The repository does not own tunnel credentials or
publish a public ingress endpoint.

## Semantic Worker Execution Boundary

Delegation uses versioned repository-owned task, result, interaction, and review
artifacts. The provider-neutral execution substrate adds three bounded layers:

1. `repo_task_admission` reads whether the expected exact task is absent, matches
   its own active registration and exact worktree binding, or conflicts with the
   requested task's lifecycle or binding state. Unrelated active task
   registrations do not deny an exact match.
2. An admitted Delegation v3 run receives one immutable dispatch record followed
   by at most one immutable launch-intent record.
3. A supervisor-owned queue consumer records typed service identity and health,
   then accepts one bounded launch outcome. A persisted launch intent without a
   result, or any unknown effect, is terminal no-replay evidence.

The normal HTTP server construction does not start that queue consumer, select a
provider, or spawn an App Server. A separately activated owner-local runner is
the only production queue consumer; it uses the already managed App Server socket
and makes no credential, daemon, remote-control, or repository-policy changes.
The launcher and continuation connection remain injectable boundaries, so provider-free tests can qualify
admission, dispatch, continuation, exactly-once, health, privacy, and no-replay
semantics without contacting a model. Provider adapters, credentials, model
selection, and live execution authority remain outside public MCP inputs and
HTTP server startup. A worker result is evidence; repository validation and
review remain authoritative.

## Installed Fable static compatibility

MCP の native receipt v3 / retention record v2 読戻しは、router ソース
`b5a73e7cd37bf0d1524976b4dea783547f3213f0` の launcher と router、および
閉じた五つの依存ファイルに明示的に固定します。依存は
`task_prior_archive.py`、`review_response_retention_bootstrap.py`、
`review_lineage_reconciliation.py`（各 0700）、`route-policy.json`（0600）、
`resolver_registry.py`（既存 0644 を維持）です。

describe より先に、七つの固定パスについてサイズ、SHA-256、所有者、mode、
regular file、単一 link、非 symlink を検査します。一つの no-follow descriptor
から上限付きで読み、読み前後および名前側の identity を照合します。
これは preflight 時点の静的検査であり、継続的な installed-byte lock、
provider attestation、runtime activation、任意の root / executable 選択ではありません。
不一致は接触前に fail-closed となり、既存 installed bytes は書き換えません。

このソース固定は v2–v6 の既存互換修正までです。v6 は完全な archive が存在する
再審査専用であり、歴史的な欠落本文を回復しません。managed missing-body 専用 v7
入口は未適用です。MCP 候補の activation と launcher / router pin の整合性は別の
条件であり、activation 前に activation 後のツール公開を要求しません。
ただし、現在の運用回復 gate は未実行可能のままです。
