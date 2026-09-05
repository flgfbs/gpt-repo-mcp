# 既存タスクへの bounded messaging

この実装は既存タスクの宛先解決、最大 8 宛先への明示的な継続、配信証拠の
読み戻しを追加する。通常の設定では無効であり、ソースと provider-free テストの
完成だけでは ChatGPT から通信できる状態を意味しない。既存 managed-run API は
変更せず、UI タスクを managed run として登録・偽装しない。

## 実際の transport と残る境界

実装時に installed Codex CLI と既存 control socket の初期化応答は `0.153.4`、
その CLI から出力した experimental schema には `thread/read`、`thread/items/list`、
`thread/inject_items`、`turn/start` が存在した。
[公式 App Server 仕様](https://learn.chatgpt.com/docs/app-server) も照合した。

| 宛先 / 効果 | この実装の動作 | 運用上の限界 |
| --- | --- | --- |
| 既存 Codex UI task の解決 | exact ID に対する `thread/read` | title を identity にしない。account 全体を列挙しない |
| `notify` | `not_delivered` / `passive_transport_unverified` | connection を開かず、生成・steering・interrupt・resume なし |
| loaded + direct-input capable な UI task の `continue` | `turn/start` の固定 `toolOutput` | idle なら生成開始、active なら進行中 turn へ入力する明示的効果 |
| `notLoaded` または直接入力不可 | `not_delivered` | 所有者を移す resume や replacement thread を作らない |
| managed App Server run | `unsupported_namespace` | 既存 `repo_continue_agent_run` の namespace / 状態管理を維持 |
| ChatGPT parent task | `unsupported_namespace` | Codex native task tool が agent にあっても local MCP からは呼べない |

元の既存 UI タスクについて、native UI metadata の active と control socket の
`notLoaded` / `canAcceptDirectInput: null` が一致しなかった。read は成功したが、
その connection が UI 所有の実行中タスクへ直接入力できるという証拠は得られていない。
この essential acceptance case は未完了である。別 App Server の起動・resume で
同じ保存履歴を開いても、元の UI 所有者との通信の証明にはならない。

`thread/inject_items` は model-visible な履歴の追加を表す。user-visible な
受信箱、配信通知、読了や acknowledgement を保証する API とは確認できなかった。
そのためこの source は inject を一切呼ばず、架空の assistant/user/system message
や tool result を挿入しない。将来の受動通知には、既存 UI 所有者に届く supported
transport と、生成を伴わない persistence/readback の確認が必要である。

## Public contract

公開 surface の末尾に次の 3 tool を追加し、既存 66 名の順序と schema を維持する。

- `repo_task_message_resolve`: `repo_id` と owner-configured `recipient_id` alias を
  解決し、private binding の digest と実際の capability を返す。
- `repo_send_task_message`: `operation_id`、安定した `message_id`、1–8 件の
  `{recipient_id, expected_binding_sha256}`、`mode`、最大 2,000 文字の `summary`、
  最大 8 件の `{repo_id, path}` evidence locator を受け取る。
- `repo_task_message_read`: `repo_id` と `message_id` を読み、必要なら recipient の
  保存済み item を照合する。外部書き込みは行わない。

未知 field は MCP SDK 境界でも拒否する。raw Responses items、roles、sender identity、
tool name/output、URL、command、model/effort/provider、cwd/sandbox/approval override、
任意の task ID や managed run ID を public send input に渡すことはできない。
送信 tool は open-world mutation として公開し、read-only と偽って host に露出させない。

evidence locator は source repository 内に限定し、宛先が別 repository でも第三の
repository の情報送信権限を引き継がない。既存 secret/path protections を適用する。

継続では実際に呼ばれた `repo_send_task_message` の forwarding result を固定した
tool name の `toolOutput` として渡す。`input` は空であり、user message を偽装しない。
envelope 内の source は `repository_mcp_tool` と source repository である。
認証されていない ChatGPT conversation や owner 本人が発信したと主張しない。
summary/evidence は外部の非信頼データであり、受信側の execution/approval checks を
置き換えない。明示的 `continue` は生成・active-turn feed の許可を表し、merge、
provider retry、activation、release の新しい許可ではない。

## Owner-controlled binding

private runtime config の optional `task_messaging` が唯一の grant source である。
public tool で登録・権限拡張はできない。既存設定にこの field がなければ無効である。
一度承認済み関係を設定すれば通常メッセージごとの再登録は不要で、Git HEAD の変化で
binding を失効させない。別 repository の依存先も正当な grant に含められる。

`grants` の各 entry は source repo、recipient alias、`owner_uid`、relationship
(`owner_specified` / `parent` / `child` / `dependency`)、許可された modes、namespace を
固定する。Codex UI の binding は UUIDv7 target/session ID、created timestamp、
canonical cwd、project ID（未設定なら null）、provider、source を first-party
`thread/read` と照合する。同一 source 内で重複 alias または重複 target を拒否する。

owner は local OS user として管理する。server は同一 UID の owner-only socket を
既存の検証済み client で利用し、grant の UID も照合する。この contract は cloud
account identity を取得・認証するものではない。ChatGPT-side project ID と App Server
`projectId` の namespace を混ぜず、null を便宜的に別 ID へ置換しない。
別 source repo や materially broader な payload の許可は継承しない。

## Durable evidence と再送

private runtime root の `messaging/` に message、operation、recipient fence を保存する。
既存 `SecureRuntimeFs` と process 間 lock を再利用し、0600 file / 0700 directory、
bounded read、checksum、atomic replacement、fsync を利用する。source tree や
`runner.session.json`、managed task/run registration は書き換えない。

message identity は source repo と `message_id` から決まり、operation ID の変更では
同じ内容を再送しない。同じ message ID の内容・宛先変更、同じ operation ID の別 message
への流用は conflict になる。recipient 単位の fence は別 message ID でも未解決の効果を
迂回できなくする。contact 前に uncertainty と fence を永続化し、その後にだけ送信する。

| State | 証明できること |
| --- | --- |
| `prepared` | ローカルで準備しただけ。consumer、queue、配信を意味しない |
| `not_delivered` | capability/policy/precontact failure または明示的な transport rejection |
| `accepted` | App Server が返した turn ID を保持。persistence は未確認の場合がある |
| `persistence_verified` | 同じ recipient の固定 tool name / namespace / 完全一致 envelope を確認 |
| `uncertain` | 送信された可能性がある。再送禁止 |

public result は元の recipient binding digest と private turn/item ID の hash reference
を返す。alias の再設定で過去の receipt を新宛先への配信と見なさない。accepted turn、
保存済み item、acknowledgement は別扱いで、acknowledgement は常に `unobserved`。
recipient が読んだ、考えた、実装した、返信したという主張はしない。

paginated history の照合は最大 4 page × 100 item、legacy は既存 RPC の 4 MiB frame
制限内で bounded parsing を行う。照合窓の外、method unsupported、欠損、重複、content
mismatch、disconnect は不確かなまま残す。空の readback を no-send と見なさない。
通知・acknowledgement の自動返信、scheduler、background relay worker は存在しない。

成功した fan-out recipient は別 recipient の失敗で再通知しない。`prepared` のまま
中断した recipient のみ、同じ message identity で未着手作業を続けられる。
`not_delivered` は同じ message の中で自動再試行しない。原因が修復され、前の効果が
明確に不在と確認された場合に限り、呼び出し元は別 message を明示的に送れる。
不確かな状態は readback が一致するまで解除しない。exactly-once delivery は保証しない。

## 4 surface の検証と activation

1. Source registry: 既存 prefix に 3 tool を追加。strict input と annotation を検証する。
2. Isolated built runtime: scratch config / runtime root の `tools/list` で 69 tool を確認する。
3. Installed runtime: 調査時は `0.1.0` / 66 tool、うち 34 read-only、新 tool は未公開。
4. Actual ChatGPT connector: この実装タスクから現在の ChatGPT action catalog は取得できない。
   Codex 側 connector の 66 tool の availability と ChatGPT 側の露出を同一視しない。

以前の ChatGPT 側 34 action と installed server の read-only 34 件は一致するが、
host filtering の原因を証明する metadata ではない。activation 後に実際の ChatGPT
surface から discovery と exact-target send/readback を実施するまで、communication-enabled
と報告しない。host 設定変更や繰り返しの @mention でこの差を隠さない。

運用担当が別途許可を受けて進める境界は、independent cross-family material review、
共有 runtime 所有者との調整、exact candidate の導入、owner grants の設定、harmless な
exact-target end-to-end test である。このタスクは runtime replacement/reload、
permission/account/tunnel 変更、live test、生成、Ready、merge、release を実行しない。

later test は元から存在する owner-approved UI task を対象にする。notify の現実装で
期待する結果は `not_delivered` と生成なしであり、成功する受動通信 test にはならない。
continue は同じ UI 所有 task が loaded/direct-input capable と確認され、生成または
active-turn feed を明示的に承認された場合だけ、固定 status 文を 1 回送って完全一致の
readback を得る。元の task が notLoaded のままならそこで停止する。
ChatGPT-parent と fan-out は別の acceptance case として扱う。

rollback は新しい送信を無効化し、既存 runtime への復元を共有 runtime 所有者が行う。
受信済み context・生成・private delivery ledger を消して「未送信」に戻してはならない。
uncertain があれば同じ message の query-only reconciliation を保持する。

## Review / 検証入口

material review は public authority、durability、concurrency、failure semantics を対象と
するため `FABLE_MAX_REQUIRED`。この作業の deterministic tests は independent review の
代替ではない。provider contact と旧 review allowance の流用は行わず、exact candidate
の diff、ここに記載した制約、production-adapter tests を later review の入力とする。
private runtime IDs と receipt body は public Git / review input に含めない。

```bash
npx vitest run tests/task-messaging.test.ts tests/tool-contracts.test.ts tests/lifecycle-tool-contracts.test.ts
npm run typecheck
npm test
npm run lint
npm run verify:dist
git diff --check
```
