# Delegation Triggers Rule

タスクの自動振り分けルール（Claude Code Orchestra の Hooks 代替）。

## 概要

このルールは常時適用され、ユーザー入力を受け取った時点で自動的に判断を行う。

## 判断フロー

```
ユーザー入力を受け取る
    ↓
【チェック1】設計判断が必要か？
    → Yes: /plan を提案、または codex-system スキルを使用
    ↓
【チェック2】TDDが必要か？
    → Yes: /tdd を提案
    ↓
【チェック3】デバッグが必要か？
    → Yes: codex-system スキルを使用
    ↓
【チェック4】実装が完了したか？
    → Yes: codex-system スキルでレビューを提案
    ↓
Antigravity が直接実行
```

## キーワード検出

### codex-system スキルを使用

**設計系:**
- 日本語: 「設計」「アーキテクチャ」「どう作る」「どう実装」
- 英語: design, architecture, how to build, approach

**デバッグ系:**
- 日本語: 「なぜ動かない」「エラー」「バグ」「原因」
- 英語: debug, error, bug, why, not working

**レビュー系:**
- 日本語: 「レビュー」「チェック」「確認して」「見て」
- 英語: review, check, verify

### /tdd ワークフローを提案

- 日本語: 「テスト」「TDD」「テスト駆動」
- 英語: test, TDD, test-driven

### /plan ワークフローを提案

- 日本語: 「計画」「プラン」「実装計画」「どう進める」
- 英語: plan, implementation plan, how to proceed

## 重要: 役割境界の遵守

以下を検出したら、Antigravity は直接実行せず委譲する：

| 検出パターン | アクション |
|-------------|-----------|
| テスト設計の依頼 | 「/tdd ワークフローで進めますか？」と提案 |
| 設計判断の依頼 | 「codex-system で Codex に相談しますか？」と提案 |
| 複雑なバグ修正 | 「codex-system で原因分析を委譲しますか？」と提案 |

## 自動判断の透明性

委譲を判断した場合、ユーザーに理由を伝える：

```
「設計」というキーワードを検出しました。
この質問は Codex CLI に委譲して深い分析を行いますか？

[はい] [いいえ、自分で答えて]
```
