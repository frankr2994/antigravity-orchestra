# Testing Rule

テストは、実装が自分で作った前提ではなく、要求と実運用契約を検証する。
詳細な完了条件は `implementation-integrity.md` に従う。

## TDD

### Red-Green-Refactor

1. **Red**: 本番コードの欠落または不具合によって失敗するテストを書く
2. **Green**: 要求を満たす最小限の本番コードを書く
3. **Refactor**: 同じテストを通したまま責務と構造を改善する

Red の失敗理由を確認する。テスト自身の誤り、存在しない fixture、無関係な環境差で
失敗する状態を Red と数えない。

## Production Contract First

- 状態、イベント名、スキーマ、バリデーター、ルート、ポリシーは本番モジュールから
  import する。テスト内に同じ一覧や型を手書きしない
- テスト名が API、永続化、Git、SSE、マイグレーション、復旧などの境界を主張する場合、
  その実際の本番エントリポイントを通す
- 外部サービスの test double は、公式仕様または記録・サニタイズした fixture に基づく。
  実装に都合のよい JSON、状態、エンドポイントを発明しない
- 仕様と実装が同じ定数を共有するだけでは契約テストにならない。独立した権威ある期待値と
  比較する
- アーキテクチャテストは実 import graph を検査し、意図的な違反 fixture が確実に失敗する
  ことを検証する

## Test Doubles

外部依存は置き換えてよいが、テストが証明すると主張する境界や安全条件を mock で消さない。

- HTTP transport を fake にする場合も wire fixture は権威ある契約に従う
- SQLite、Git、filesystem、HTTP server など軽量な境界は、保証の実在性が上がる場合に
  temporary/local 実装を優先する
- 時刻、乱数、process runner、network transport は port として注入する
- `skipPush`、`skipFetch`、`skipVerification`、`disableValidation` のような本番形状の
  safety bypass をテスト目的で追加しない

## Risk-Based Test Layers

Unit / integration / contract / end-to-end の固定比率は設けない。変更のリスクに応じて、
必要な境界を直接検証する。

最低限の例：

| 変更 | 必要なテスト証拠 |
|---|---|
| 純粋なドメイン規則 | unit、境界値、未知状態、矛盾する入力 |
| HTTP route | mounted router への実リクエスト、validation、error mapping |
| database / migration | temporary DB、fresh/legacy parity、途中失敗、transaction rollback |
| provider API | 公式/記録 fixture、malformed response、pagination、rate limit、abort |
| Git / worktree | temporary repo/remote、exact SHA、nonzero exit、衝突、cleanup failure |
| durable workflow | partial write、timeout after acceptance、duplicate、restart、reconciliation |
| lease / concurrency | concurrent owner、expiry、renewal、stale owner、fencing |
| untrusted execution | sandbox policy、allowlisted environment、limits、no-check state |

## Failure Behavior

安全性、ライフサイクル、耐久性、並行処理に関わる happy-path テストには、関連する
negative / fault-injection テストを追加する。

必要に応じて以下を検証する：

- malformed / missing / unknown input or response
- command nonzero exit and partial output
- timeout before and after remote acceptance
- duplicate invocation and retry
- partial database failure
- crash and restart at durable checkpoints
- concurrent callers, expired lease, stale owner
- changed remote SHA or ownership mismatch
- cancellation ambiguity
- cleanup failure and corrupt persistence
- verification commandが一つも設定されていない状態

エラー、unknown、empty、not configured を成功として期待するテストを書かない。

## Coverage and Naming

カバレッジ率は診断情報であり、正しさの証明ではない。固定の 70/20/10 比率や、数字だけの
完了基準より、invariant、state transition、error path、external contract、restart、
concurrency の未検証箇所を優先する。

テスト名は実際に通した境界と証明した条件だけを表す。`end-to-end`、`secure`、`isolated`、
`100% compatible` といった名称を、対応する性質を検証せず使用しない。

## Test Structure

Arrange-Act-Assert を基本とし、失敗時にどの契約が壊れたか判別できる assertion を使う。
テスト間の依存を作らず、各テストは所有する temporary resource を確実に cleanup する。

## Role Boundary

- 重要機能、複雑な workflow、architecture、security、durability、concurrency のテスト戦略は
  Codex に委譲する
- Antigravity は戦略を実装し、実装中に判明した明白な regression / failure-path テストを
  追加する
- Antigravity は、コードを通すために Codex の受け入れテストを弱めたり、実装側の前提へ
  書き換えたりしない

## 禁止事項

- テストなしで安全性や完了を主張する
- 理由と期限を記録せずテストを skip する
- 本番環境や実ユーザーデータへ影響するテストを書く
- pre-existing failure と今回導入した failure を混同する
- focused test の成功だけで、未実行の build / lint / integration を成功扱いする
