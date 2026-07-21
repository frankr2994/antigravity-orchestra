---
name: tdd
description: Red-Green-Refactor サイクルでテスト駆動開発を進める
---

# /tdd - テスト駆動開発ワークフロー

## Step 1: テストケース設計（Codex CLI に委譲）

`codex-system` スキルを使用してテストケースを設計。

**プロンプト例**:

```
Design test cases for: {機能名}

Follow TDD principles:
1. What should be tested?
2. Edge cases?
3. Expected behaviors?
```

## Step 2: 失敗するテスト作成 - Red（Antigravity）

Codex のテスト設計に基づき、テストコードを作成。

- テストファイルを作成
- テストが失敗することを確認（Red状態）

## Step 3: 最小限の実装 - Green（Antigravity）

テストを通すための最小限のコードを実装。

- 余計な機能は追加しない
- テストが通ることを確認（Green状態）

## Step 4: リファクタリング - Refactor（Codex CLI に委譲）

`codex-system` スキルでリファクタリングの提案を受ける。

**プロンプト例**:

```
Review this code for refactoring opportunities:

{実装コード}

Tests are passing. Suggest improvements for:
1. Readability
2. Performance
3. Maintainability
```

## Step 5: 繰り返し

全てのテストケースが完了するまで Step 2-4 を繰り返す。
