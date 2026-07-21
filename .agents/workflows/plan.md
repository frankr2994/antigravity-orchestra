---
name: plan
description: 要件を具体的な実装ステップに分解する
---

# /plan - 実装計画ワークフロー

## Step 1: 要件の明確化（Antigravity）

ユーザーに確認：

- 何を実装するか
- 制約や条件はあるか
- 優先度はどうか

## Step 2: 計画作成（Codex CLI に委譲）

`codex-system` スキルを使用して計画を作成。

**プロンプト例**:

```
Create an implementation plan for: {要件}

Provide:
1. Implementation steps (file, changes, verification)
2. Dependencies and risks
3. Verification criteria
```

## Step 3: 計画の確認（Antigravity）

Codex の計画をユーザーに提示し、承認を得る。

- 各ステップの説明
- リスクと対策
- 所要時間の見積もり

## Step 4: ドキュメント更新

承認された計画を `docs/DESIGN.md` に記録。
