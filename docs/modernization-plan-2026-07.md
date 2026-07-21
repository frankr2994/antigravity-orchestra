# 現代化改修計画（2026-07-21 実施済み）

> **テンプレート作者の開発記録**（設計判断の透明性のために公開）。テンプレート利用者が読む必要はなく、コピー先では削除して構いません。実施結果を Status 列に反映済み。

## 背景

2026-02 作成時の前提（WSL2 内 Codex、`gpt-5.2-codex` ハードコード、`--full-auto`、Antigravity IDE 前提）が陳腐化したため、公開テンプレートとして現代化した。姉妹プロジェクト grok-orchestra の実装プラン形式（検証ゲート・doctor・Pester/CI）を反映している。

## 実施内容と結果

| Phase | 内容 | Status |
|-------|------|--------|
| 1 | スクリプト現代化: Windows ネイティブ codex CLI、PATH 自動解決、モデルは config.toml 継承（`-Model` で上書き）、stdin プロンプト、エラーログ保存、UTF-8 BOM 対応（PS 5.1 実証済み）、共有モジュール `CodexHelpers.psm1` へ集約 | DONE |
| 1b | `review.ps1` を `codex exec review --uncommitted`（`-BaseRef` で `--base`）に置換し、レビュー範囲を決定的に | DONE |
| 2 | Pester 17 テスト（fake-codex フィクスチャで codex 非依存）+ GitHub Actions CI（windows-latest） | DONE |
| 3 | `check.ps1`（doctor）: Codex/認証/agy/レイアウト/gitignore を OK/WARN/FAIL 診断 | DONE |
| 4 | CLI 標準化: `.agent/` → `.agents/`（現行 CLI/IDE の公式規約）、ルート `AGENTS.md` 新設（ワークフローブリッジ）、README を `agy` CLI 前提に | DONE |

## 設計判断の記録

- **モデル名をハードコードしない**: 版数固定が陳腐化の根本原因だったため、Codex は `~/.codex/config.toml` 継承、Gemini は README から版数表記を排除
- **`.agents/`（複数形）が正**: agy CLI バイナリの探索パス `{workspace}/.agents/skills/{skill_name}/SKILL.md` および builtin `agy-customizations` スキルの仕様で確認
- **workflows は CLI の概念に存在しない**: ルート `AGENTS.md` から `.agents/workflows/*.md` へブリッジし、IDE ワークフローと両立
- **`--sandbox read-only` を明示**: ユーザー config が緩くても委譲実行が書き込み不可になるよう常時指定
- **Codex レビュー指摘の反映**: ログのリポジトリルート固定（cwd 依存の情報漏えい防止）、タイムスタンプ衝突回避（ms+PID）、`$PSNativeCommandUseErrorActionPreference` 対応、PS 5.1 BOM 問題、`Get-Command -CommandType Application` による shadow 回避

## 見送り事項

- **install.ps1 ワンコマンド導入**: フォルダコピーで導入が完結するため現時点で不要。摩擦が観測されたら再検討
- **walkthrough 実トランスクリプト**: README 全面改訂と合わせて後続プランで
- **agy ヘッドレス（`-p`）でのワークスペーススキル注入**: 実機プローブでは `-p` 実行時に `.agents/skills/` が注入されないことを確認（グローバル+builtin のみ）。対話モード（TUI）での `/skills` 確認は未実施。CLI 側の headless 制約の可能性があり、挙動が変わったら README を追従させる

## 検証記録（2026-07-21）

- `ask_codex.ps1`: PONG スモーク / 日本語+引用符+複数行 / `-Model` 上書き / 異常系 exit 1 — すべて実機パス
- `review.ps1`: `codex exec review --uncommitted` 実機実行で実際の指摘（P1×3）を取得
- `check.ps1`: クリーン環境で全項目 OK・exit 0、レイアウト欠落時 FAIL・exit 1（テスト化済み）
- Pester: 17/17 パス（pwsh 7）。PS 5.1 でもパースエラー 0・実行確認済み
