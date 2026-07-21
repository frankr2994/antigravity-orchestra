---
name: init
description: 新規プロジェクトにOrchestra環境をセットアップする
---

# /init - Orchestra環境初期化ワークフロー

## 概要

このワークフローは一度だけ実行し、必要なディレクトリとファイルを作成する。

## Step 1: ディレクトリ構造の確認

以下のディレクトリが存在するか確認：

```
.agents/
├── workflows/
├── skills/
│   ├── codex-system/scripts/
│   ├── design-tracker/
│   ├── research/
│   ├── update-design/
│   └── update-lib-docs/
└── rules/

.codex/

docs/
├── research/
└── libraries/

logs/
└── codex-responses/
```

## Step 2: 不足ディレクトリの作成

存在しないディレクトリを作成。

## Step 3: 設定ファイルの確認

以下のファイルが存在するか確認：

- `.agents/workflows/*.md` (6ファイル)
- `.agents/skills/*/SKILL.md` (5スキル)
- `.agents/rules/*.md` (8ファイル)
- `.codex/AGENTS.md`
- `docs/DESIGN.md`

## Step 4: 不足ファイルの作成

存在しないファイルをテンプレートから作成。

## Step 5: 環境診断（doctor）

PowerShell で診断スクリプトを実行：

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

Codex CLI / 認証状態 / agy CLI / テンプレートレイアウト / .gitignore を OK / WARN / FAIL で検査する。FAIL があれば表示された修正案内に従う（例: Codex CLI 未導入なら公式インストーラー `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"` → `codex login`）。

パス設定は不要（スクリプトが PATH から自動解決する）。

## Step 6: 完了報告

セットアップ完了を報告し、次のステップを案内：

```
Orchestra環境のセットアップが完了しました。

次のステップ：
1. check.ps1 が FAIL を出した場合は修正して再実行
2. /startproject で最初のプロジェクトを開始
```
