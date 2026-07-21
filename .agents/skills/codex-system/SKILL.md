---
name: codex-system
description: Use this skill when design decisions, debugging, or code review is needed. Delegates complex reasoning to Codex CLI.
---

# Codex System Skill

設計判断・デバッグ・レビューを Codex CLI に委譲する。

## いつ使うか

以下のキーワードを検出したら、このスキルを使用：

### 設計判断
- 「どう設計」「アーキテクチャ」「どう作る」「design」「architecture」
- 「どのアプローチ」「どちらがいい」「比較」「trade-off」

### デバッグ
- 「なぜ動かない」「エラー」「バグ」「debug」「error」「bug」

### レビュー
- 「レビュー」「チェック」「確認」「review」「check」

## 使わないとき

- 単純なファイル編集
- リサーチ・調査（Antigravity自身が行う）
- ユーザーとの会話

## 実行方法

### 設計・デバッグ（分析のみ）

```powershell
.\scripts\ask_codex.ps1 -Mode "analyze" -Question "{質問}"
```

### レビュー

```powershell
.\scripts\review.ps1              # staged + unstaged + untracked の変更をレビュー
.\scripts\review.ps1 -BaseRef main  # main ブランチとの差分をレビュー
```

### 環境診断

```powershell
.\scripts\check.ps1
```

## 言語プロトコル

1. **Codex へは英語で質問** - 推論精度が向上
2. 英語で回答を受け取る
3. **ユーザーには日本語で報告**

## 結果の活用

1. Codex の回答を `logs/codex-responses/{mode}-{timestamp}.md` に保存
2. 設計決定があれば `docs/DESIGN.md` に記録
3. ユーザーに日本語で要約を報告

## 安全性

- Codex は `--sandbox read-only` モードで実行
- ファイル変更は Antigravity が行う
- Codex は分析と提案のみ
