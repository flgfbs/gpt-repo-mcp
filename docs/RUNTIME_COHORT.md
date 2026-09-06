# 固定 MCP runtime cohort の交換と既知の復元

`scripts/mcp_runtime_cohort.py` は owner-local の専用実行器です。MCP tool、任意パスの
installer、source integration、service manager、review authority ではありません。
公開 tool catalog・設定・権限・router の byte を変更しません。

## 九つの固定対象

`node_modules/@esbuild/darwin-arm64`、`node_modules/esbuild`、
`node_modules/fast-uri`、`node_modules/hasown`、`node_modules/qs`、
`node_modules/side-channel`、`node_modules/tsx`、
`node_modules/.package-lock.json`、`dist` だけを交換します。
他の package を指定する入力はありません。対象外 runtime は exact census・bytes・mode・
identity を照合し、`.vite` の内容は読みません。source/Git と top-level 設定等は非変更です。
private state の内部は探索せず、独立した writer 停止・排他の実証を前提にします。

## 起動防止と回復

承認済みの別操作で service と owner runner を静止させ、正式な task/lock 状態で writer の
排他を確認してから実行します。実行器自身は停止や restart を行わず、固定 macOS の process
と open-file census が不明・実行中なら停止します。既存 lock は破りません。

最初の atomic exchange で `dist` 全体を保存し、空の 0700 directory を起動口に置きます。
その後だけ依存対象を交換し、全候補が揃った最後に candidate `dist` を公開します。
同じ `dist/server.js`、CLI、owner runner entrypoint で restart されても、途中は entrypoint
自体が存在しません。停止指示だけを永続 fence の代用にはしません。
source `dev`、手動 `npm ci/build`、別 entrypoint、他 writer の起動はこの方式の保証対象ではなく、
運用 gate の排他条件として禁止します。悪意ある同一 UID の writer を OS 権限で隔離する機構ではありません。

回復 controller は、交換される root の外に置いた byte-bound 単一 Python ファイルです。
Python 標準ライブラリと OS の atomic exchange だけを使い、交換中の Node/dependency に依存しません。
各交換の前に append-only intent、後に exact identity/content readback を記録します。
中断時は intent の前後どちらか一意に一致する場合だけ既知の状態として読み戻せます。
その状態で apply は再実行しません。別途許可された rollback だけが、保存された元の inode と
hardlink topology を逆順に戻せます。再起動した controller でも同じ検査を行います。

候補稼働後の rollback は先に候補 `dist` を fence に戻し、依存群、最後に元の `dist` を戻します。
保存側の欠落、drift、未知ファイル、journal 不整合、権限不一致は no-replay の停止です。
archive を使って消えた saved side を自動再生成する機能はありません。その場合は保全して
具体的な回復判断へ返します。成功後も保存側・archive・journal を自動削除しません。

## 入力と実行境界

非公開の `mcp-fixed-runtime-execution.v1` manifest は、operation ID、canonical installed
root と inode/owner/mode、外部 controller の path/SHA-256、固定 materials の path/SHA-256、
service plist の path/SHA-256、writer exclusion の証拠参照を持ちます。
materials は `mcp-fixed-runtime-materials.v1` の candidate/installed 全対象 entry、所有者、
hardlink 関係、source HEAD/tree、対象外 runtime entry と exact candidate archive を束縛します。
実行器は source HEAD/tree/clean を確認し、runtime overlay を source 更新に読み替えません。
材料や manifest の path、private evidence、実 owner 値を公開ソースへ埋め込みません。

`prepare` も実 installed root に専用 staging/journal を作る consequential operation です。
source 実装・合成テストの許可だけで実行してはいけません。`apply`、service restart、review、
promotion、rollback 実行、merge はそれぞれ正確な gate の対象です。
manifest、digest、CLI 引数を所持するだけで承認が成立するわけではありません。
`status` は既存 operation の readback のみです。

運用 gate は材料・controller の commit/byte、service quiescence、個別 review packet と
admission、暫定 activation が必要な条件、接触上限、結果別 disposition、復元対象を具体的に
結びます。レビューに必要な provisional activation は条件付き subeffect とし、循環条件を作りません。
MCP の回復 verdict を router 自身の qualification/promotion に転用しません。

## 合成検証

通常の `npm test` は `tests/mcp-runtime-cohort.test.ts` から Python の filesystem 回帰を
実行します。全 writable root は disposable fixture で、service/provider/GitHub への接触はありません。
実 atomic exchange、閉じた旧 hardlink、各 apply/rollback 中断点、実 Node entrypoint restart、
drift、symlink、未知 member、保存側欠落、排他、非変更を確認します。
障害注入の組合せテストは Git を安定した合成 seam に置き換えます。実 Git の状態照合は
独立した drift テストと実 Node restart の end-to-end テストで維持し、ファイル交換・journal・
hardlink・回復処理は全ケースで本番実装を通します。
これらは source 検証であり、実 installed recovery、独立 Fable review、運用完了ではありません。
