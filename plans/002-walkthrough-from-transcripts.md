# Plan 002: 実トランスクリプト付き walkthrough を書く

> **Executor instructions**: このプランをステップ通りに実行する。STOP conditions に
> 該当したら即停止して報告する。完了したら `plans/README.md` の Status 表を更新する。
>
> **Drift check (run first)**: Plan 001 が DONE であること（`plans/README.md` 参照）。
> `docs/DESIGN.md` に demo-todo の設計決定が記録されていること。未達なら STOP
> （先に Plan 001 を完了させる）。

## Status

- **Priority**: P2 / **Effort**: S / **Risk**: LOW（ドキュメントのみ）
- **Depends on**: plans/001-dogfood-startproject-cycle.md
- **Planned at**: 2026-07-21

## Why this matters

README は思想の説明に留まり、「動いている姿」がリポジトリに存在しない。OSS テンプレートの採用判断は「実際に動くところを 3 分で見られるか」で決まる。Plan 001 で採取した**実際の**トランスクリプト（Codex 応答ログ、check.ps1 出力、各フェーズの流れ）を `docs/walkthrough.md`（英）+ `docs/walkthrough.ja.md`（日）にまとめ、README から誘導する。

## Scope

**In scope**:
- `docs/walkthrough.md` / `docs/walkthrough.ja.md`（create）
- `README.md` / `README.en.md`（Step 4 の直後に walkthrough への 2 行リンク追記のみ。既存行の削除ゼロ）

**Out of scope**:
- `.agents/` 配下・スクリプト・テスト
- `logs/` 配下のコミット（gitignore を変えない — 抜粋を本文へ貼り込む）
- スクリーンキャスト・GIF（テキストのみ）

## Steps

### Step 1: 素材の収集

Plan 001 の実行時に生成された以下を集める:
- `check.ps1` の実出力
- `logs/codex-responses/` の Codex 応答（設計レビュー / QA の 2 本以上）
- 各フェーズでのユーザー↔agy のやり取りの要点

**Verify**: すべて実採取であること。**捏造・再構成した出力で埋めない**（不足していれば該当ステップだけ再実行して採取する）。

### Step 2: walkthrough を書く

構成（コードブロックはすべて実出力の抜粋。長い出力は `(...snip...)` で省略し、その旨明記）:

1. 前提（check.ps1 の実行結果）
2. /startproject の 6 フェーズが実際にどう流れたか（フェーズごとに 1 節）
3. Codex 委譲の実例（ask_codex.ps1 の呼び出しと応答抜粋、ログの場所）
4. review.ps1 による最終レビュー（実指摘と対応）
5. 次の一歩（このテンプレートを自分のプロジェクトにコピーする手順）

**Verify**: 本文中の全コマンドをコピペ再実行してすべて成功する（再現性チェック）。
抜粋にユーザー名入り絶対パス等の環境固有情報が写り込んでいないことを確認する。

### Step 3: 日本語版と README 導線

`walkthrough.ja.md` は翻訳（トランスクリプト抜粋は共通で可）。両 README の
Step 4（動作確認）直後に「See the full cycle: docs/walkthrough.md」相当の 2 行を追記。

**Verify**: `git diff README.md README.en.md` が追記のみ（既存行の削除ゼロ）。

## Done criteria

- [ ] walkthrough 2 言語が存在し、全コマンドが再現可能
- [ ] トランスクリプト抜粋がすべて実採取
- [ ] `git status` に `logs/` 配下が現れない
- [ ] README 両言語に導線あり、既存行の削除ゼロ
- [ ] plans/README.md の Status 更新
- [ ] ブランチ `docs/002-walkthrough`、push はユーザー確認後

## STOP conditions

- Plan 001 が未完了
- 実トランスクリプトが採取できない（**捏造で埋めずに報告**）
- README への追記が既存行の変更を要求する構成になった（設計相談に戻す）
