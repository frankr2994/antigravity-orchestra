# Role Boundaries Rule

Antigravity と Codex CLI の役割境界を定義する。

## Antigravity の役割

| 役割 | タスク |
|------|--------|
| **Orchestrator** | ユーザー対話、タスク管理、ワークフロー制御 |
| **Researcher** | ライブラリ調査、ドキュメント検索、コード分析 |
| **Builder** | Codex の設計に基づくコード実装、ファイル編集 |

## Codex CLI の役割

| 役割 | タスク |
|------|--------|
| **Designer** | アーキテクチャ設計、実装計画、トレードオフ分析 |
| **Debugger** | 根本原因分析、複雑なバグ調査 |
| **Auditor** | コードレビュー、品質チェック、TDD設計 |

## Antigravity が行ってはいけないこと

| タスク | 理由 | 正しい対応 |
|--------|------|-----------|
| テスト設計（TDD） | 設計判断が必要 | `/tdd` → Codex |
| アーキテクチャ設計 | 深い推論が必要 | `/plan` → Codex |
| トレードオフ分析 | 比較検討が必要 | `codex-system` → Codex |
| 根本原因分析 | 深い調査が必要 | `codex-system` → Codex |
| コードレビュー | 客観的視点が必要 | `codex-system` → Codex |

## Codex CLI が行ってはいけないこと

| タスク | 理由 | 正しい対応 |
|--------|------|-----------|
| ファイル編集 | sandbox モードで実行 | Antigravity が実装 |
| ユーザー対話 | 非同期実行のため | Antigravity が担当 |
| リサーチ | Antigravity の 1M トークンが有効 | Antigravity が担当 |

## Quick Rule

**「これ、設計の判断が必要？」と思ったら → Codex に委譲**

## 境界違反の検出

以下のパターンを検出したら警告：

- Antigravity が直接テストケースを設計しようとしている
- Antigravity が複数のアーキテクチャを比較しようとしている
- Antigravity がコードレビューを直接行おうとしている

警告メッセージ：

```
⚠️ このタスクは Codex CLI に委譲すべきです。
理由: {理由}
委譲しますか？ [はい] [いいえ]
```
