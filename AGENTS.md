# Antigravity Orchestra — Agent Rules

このワークスペースは「Antigravity（Gemini）がオーケストレーター、Codex CLI が設計・デバッグ・レビュー担当」のマルチエージェント構成で動く。標準インターフェースは **Antigravity CLI（`agy`）**。同じ `.agents/` 構成を読むため Antigravity IDE でもそのまま動作する。

## 基本動作

- 応答と生成ドキュメントはユーザーの言語に合わせる（`.agents/rules/language.md` 参照）
- 設計・デバッグ・レビューのキーワードを検出したら `codex-system` スキルで Codex CLI に委譲する（`.agents/rules/delegation-triggers.md` 参照）
- 役割境界を守る: Antigravity は実装・調査、Codex は分析・提案のみ（`.agents/rules/role-boundaries.md` 参照）
- 実装・修復・テストでは `.agents/rules/implementation-integrity.md` を必ず適用し、完了前に同ファイルの Completion Gate を実行する
- 外部契約、前提アーキテクチャ、安全性を無効化する Codex 指摘が残る場合、後続の依存フェーズへ進まない
- **委譲ルールは Antigravity（オーケストレーター）専用。** あなたが Codex としてこのファイルを読んでいる場合（`codex exec` で委譲されたセッション）は、再委譲せず、与えられた分析・レビュータスクに直接回答すること

## Codex セッション向けの注意

このリポジトリの `.codex/AGENTS.md` が Codex 向けの正式な指示。委譲された Codex セッションは `codex-system` スキルやスクリプトを実行してはならない（自己再帰になる）。


## ワークフロー（スラッシュコマンド）

ユーザーが以下のコマンド（または相当する依頼）を入力したら、対応するファイルを読み、そのステップに従って実行する:

| コマンド | ファイル | 用途 |
|----------|----------|------|
| `/startproject` | `.agents/workflows/startproject.md` | 新規プロジェクト開始（6フェーズ） |
| `/plan` | `.agents/workflows/plan.md` | 実装計画の立案 |
| `/tdd` | `.agents/workflows/tdd.md` | テスト駆動開発 |
| `/simplify` | `.agents/workflows/simplify.md` | コード簡素化 |
| `/checkpoint` | `.agents/workflows/checkpoint.md` | 進捗の保存 |
| `/init` | `.agents/workflows/init.md` | Orchestra 環境初期化 |

## Codex 委譲の実行方法

```powershell
.\.agents\skills\codex-system\scripts\ask_codex.ps1 -Mode "analyze" -Question "..."
.\.agents\skills\codex-system\scripts\review.ps1              # 未コミット変更のレビュー
.\.agents\skills\codex-system\scripts\check.ps1               # 環境診断（doctor）
```

詳細は `.agents/skills/codex-system/SKILL.md` を参照。

## Ripwire（決定論的コードベース探索）

Ripwire（`F:\Ripwire\ripwire-0.5.0\ripwire-0.5.0\build\ripwire.exe`）は、Orchestra パイプライン（Refinement, Builder, Review/Repair）に統合されている。grep や巨大ファイルの一括読込の前に呼び出し、コンテキスト消費を削減する：

- タスク指向マップ: `ripwire . --for="<タスク内容>"`
- 変更の影響範囲（ブラスト半径）: `ripwire . --situ`
- 回帰・品質低下の検出: `ripwire . --quality-delta`
- 実行必須テストの特定: `ripwire . --test-gate`
- 特定シンボルのみ展開: `ripwire . --expand=SYM --top-k=0`（※ `SYM` は `VendorProfileManager` などの純粋なシンボル名。ファイルパスや `file:SYM` ではなくシンボル名のみを指定）
- コールグラフ調査: `ripwire . --callers=SYM` / `ripwire . --impact=SYM`
