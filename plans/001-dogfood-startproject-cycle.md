# Plan 001: サンプル機能で /startproject フルサイクルを回す

> **Executor instructions**: このプランをステップ通りに実行する。各 Verify の
> 期待結果を確認してから次へ進む。STOP conditions に該当したら即停止して報告する
> （即興で回避しない）。完了したら `plans/README.md` の Status 表を更新する。
>
> **Drift check (run first)**: `git log --oneline -1` が `58952d1` 以降であること、
> `.agents/skills/codex-system/scripts/` に ask_codex.ps1 / review.ps1 / check.ps1 /
> CodexHelpers.psm1 の 4 ファイルがあることを確認。無ければ STOP。

## Status

- **Priority**: P1 / **Effort**: M / **Risk**: LOW（examples/ 配下の新規作成のみ）
- **Depends on**: なし
- **Planned at**: 2026-07-21, commit `58952d1`

## Why this matters

このテンプレートは現代化改修（Windows ネイティブ Codex、agy CLI 標準、`.agents/` 移行）を終えたが、**改修後のワークフローを最初から最後まで実際に回した記録がまだ無い**。テンプレートの主張（6フェーズの /startproject、Codex 委譲、役割分離）が本当に機能するかを、小さなサンプル機能で実証する。ここで得た実トランスクリプトが Plan 002（walkthrough）の素材になる。

## Scope

**In scope**:
- `examples/demo-todo/`（create）— サンプル実装の置き場所
- `docs/DESIGN.md`（テンプレ雛形に実際の設計決定を記録）
- `docs/research/`（リサーチ結果の保存）
- `logs/codex-responses/`（自動生成、gitignored）

**Out of scope（触ってはならない）**:
- `.agents/` 配下のすべて（ルール・スキル・ワークフロー・スクリプト）
- `tests/`、`.github/`、README 両言語
- ハーネスの不備を見つけても直さない — `plans/README.md` の Findings log に記録して報告する

## Steps

### Step 1: 環境診断

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

**Verify**: 全項目 OK/WARN、exit 0。FAIL があれば STOP。

### Step 2: /startproject を実行する

チャットで次を宣言してワークフローを開始する（`.agents/workflows/startproject.md` に従う）:

```
/startproject CLI で動く簡単な TODO リスト（Python、examples/demo-todo/ 配下、追加・一覧・完了の3機能のみ）
```

6 フェーズを**省略せず**順に実行する。特に:
- Phase 3（設計レビュー）と Phase 6（QA）は必ず `ask_codex.ps1` / `review.ps1` で Codex に委譲する
- Phase 5 で `docs/DESIGN.md` に設計決定を記録する

**Verify**: 各フェーズ完了時に、そのフェーズの成果物（research ファイル / 計画 /
Codex 応答ログ / タスクリスト / DESIGN.md 更新）が実在することを確認して次へ進む。

### Step 3: テストの実行

実装したサンプルのテスト（Phase 中に作成したもの）を実行し、全パスを確認する。

**Verify**: テストコマンドが exit 0。

### Step 4: 最終レビューと記録

```powershell
.\.agents\skills\codex-system\scripts\review.ps1
```

指摘があれば examples/ 配下の範囲で修正し、再実行してクリーンにする。
最後に `plans/README.md` の Status と Findings log（ワークフローの曖昧点・ルールの矛盾・
使いにくかった点を 1 行ずつ）を更新する。

**Verify**: review.ps1 が exit 0、Findings log 更新済み。

## Done criteria

- [ ] check.ps1 exit 0（開始時）
- [ ] 6 フェーズすべての成果物が存在（research / DESIGN.md / Codex ログ ×2 以上）
- [ ] examples/demo-todo/ のテストが全パス
- [ ] review.ps1 の指摘ゼロ（または対応済み）
- [ ] plans/README.md の Status = DONE、Findings log 更新
- [ ] コミットは feature ブランチ（例: `feat/dogfood-demo-todo`）、英語 conventional commits。push はユーザー確認後

## STOP conditions

- check.ps1 が FAIL を返す
- `/skills` に codex-system が表示されない（ワークスペーススキル未ロード）
- ask_codex.ps1 / review.ps1 が 2 回連続で失敗する
- ワークフロー本文の指示が現在のリポ構成と矛盾していて先へ進めない（矛盾内容を記録して報告）
