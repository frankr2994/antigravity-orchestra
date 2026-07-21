---
name: startproject
description: マルチエージェント協調でプロジェクトを開始する
---

# /startproject - プロジェクト開始ワークフロー

## 概要

このワークフローは6つのフェーズで構成され、Antigravity と Codex CLI が協調して開発を進める。

## Phase 1: リサーチ（Antigravity）

1. プロジェクト構造を分析
2. 既存コードパターンを把握
3. 関連ライブラリを調査
4. 結果を `docs/research/{feature}.md` に保存

**出力**: リサーチサマリー

## Phase 2: 要件ヒアリング（Antigravity）

ユーザーに以下を確認：

- **目的**: 何を達成したいか
- **スコープ**: 含めるもの・除外するもの
- **技術的要件**: 特定のライブラリ、パターン、制約
- **成功基準**: 完了の判断基準

確認後、実装計画のドラフトを作成。

**出力**: 実装計画ドラフト

## Phase 3: 設計レビュー（Codex CLI に委譲）

`codex-system` スキルを使用して、Codex CLI に設計レビューを委譲する。

**プロンプト例**:

```
Review this implementation plan:

## Research Summary
{Phase 1の結果}

## Draft Plan
{Phase 2の計画}

Provide:
1. Plan Assessment
2. Risk Analysis  
3. Implementation Order
4. Refinements
```

**出力**: Codex のレビュー結果

## Phase 4: タスクリスト作成（Antigravity）

1. 全入力（リサーチ + 要件 + Codexレビュー）を統合
2. 実装タスクリストを作成
3. ユーザーに最終確認

**出力**: 承認済みタスクリスト

## Phase 5: ドキュメント更新（Antigravity）

- `docs/DESIGN.md` に設計決定を記録
- 重要な判断の理由を残す

**出力**: 更新されたDESIGN.md

## Phase 6: 品質保証（Codex CLI に委譲）

実装完了後、`codex-system` スキルでレビューを実施。

- 実装バイアスを排除した客観的レビュー
- セキュリティ・パフォーマンスの確認

**出力**: 最終レビュー結果
