---
name: simplify
description: コードを簡潔化し、可読性を向上させる
---

# /simplify - コードリファクタリングワークフロー

## Step 1: 対象の特定（Antigravity）

リファクタリング対象のファイルまたはコードを特定。

- ユーザーが指定したファイル
- または複雑度が高いと判断されるコード

## Step 2: 現状分析（Codex CLI に委譲）

`codex-system` スキルで現状を分析。

**プロンプト例**:

```
Analyze this code for simplification:

{対象コード}

Identify:
1. Complex logic that can be simplified
2. Duplicated code
3. Long functions that should be split
4. Unclear naming
```

## Step 3: リファクタリング実施（Antigravity）

Codex の提案に基づき、リファクタリングを実施。

- 一度に1つの改善のみ行う
- 各変更後にテストを実行

## Step 4: レビュー（Codex CLI に委譲）

リファクタリング結果を Codex でレビュー。

**確認ポイント**:

- 動作が変わっていないか
- 本当にシンプルになったか
- 新しい問題が生じていないか

## Step 5: ドキュメント更新

大きな変更があれば `docs/DESIGN.md` に記録。
