# Dogfooding Plans — Antigravity CLI Operator Handoff

> 作成: 2026-07-21（現代化改修コミット `1122091` 時点）
> **Executor: Antigravity CLI（`agy`）— このハーネス自身のルールでドッグフーディングする。**

## 引継ぎ指示（agy Operator 向け）

あなたはこのワークスペースの Operator です。ルートの `AGENTS.md` と `.agents/`（rules / skills / workflows）に従い、下のプランを**このハーネス自身の運用ルールで**実行してください。これはドッグフーディングです: ハーネスの規律（委譲トリガー → Codex 相談 → 検証）を守れない場面、ルールや手順が曖昧・矛盾している場面に遭遇したら、**それ自体が最重要の発見**としてレポート対象になります。

### 起動方法（ユーザー向けメモ）

```powershell
cd C:\Users\sorab\Documents\Projects\apps\antigravity-orchestra
agy
```

**必ず対話モード（TUI）で実行すること。** ヘッドレス（`agy -p`）ではワークスペースの `.agents/skills` と `AGENTS.md` がコンテキストに注入されないことを実測確認済み（2026-07-21, agy 1.1.5）。セッション開始直後に `/skills` で `codex-system` 等 5 スキルが見えることを確認し、見えなければそこで停止してユーザーに報告する。

### 各プランの実行プロトコル

1. **最初に環境診断**: `.\.agents\skills\codex-system\scripts\check.ps1` を実行し、全項目 OK/WARN であること（FAIL があれば停止・報告）。
2. プランを全文読んでから着手する。**Drift check を必ず最初に実行**する。
3. 設計判断・レビューは必ず Codex に委譲する（`.agents/rules/delegation-triggers.md` の条件に従い、`ask_codex.ps1` / `review.ps1` を使用）。自分だけで設計を確定しない。
4. 実装は Antigravity（あなた）が行う。Codex は分析・提案のみ（`.agents/rules/role-boundaries.md`）。
5. 非自明な変更後は `review.ps1` を必ず通し、指摘に対応してから次へ進む。
6. 検証（テスト実行・実出力の確認）を通してから DONE を宣言する。「動くはず」は禁止。
7. 下の Status 表を更新する。
8. プランごとに feature ブランチ（`feat/...` / `docs/...`）+ 英語 conventional commits。**push / PR 作成前にユーザーへ確認する。**

### STOP 共通条件

- 同一の失敗が 2 回続いたら、第 3 の変種を試さずユーザーへ報告する（サーキットブレーカー）。
- `.agents/` のルール・スキル・ワークフロー本文と実挙動が矛盾したら、勝手に直さず矛盾内容を記録して報告する（ハーネス改善の入力になる）。
- `.agents/skills/codex-system/scripts/*.ps1` は**編集禁止**（テスト済みの検証基盤。問題を見つけたら報告のみ）。

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | サンプル機能で /startproject フルサイクルを回す | P1 | M | — | DONE |
| 002  | 実トランスクリプト付き walkthrough を書く | P2 | S | 001 | DONE |


Status values: TODO | IN PROGRESS | DONE | BLOCKED (理由1行) | REJECTED (理由1行)

## Findings log（ドッグフーディングで見つけた問題をここに追記）

- `ask_codex.ps1` / `review.ps1` の実行ログにおいて、画面表示される出力ファイルパス（PID・タイムスタンプ表記）が実際のファイル名と一部乖離する場合がある。ただし、Codex の標準出力およびレビュー内容自体は正常に捕捉される。
- Codex CLI への問い合わせ処理（`ask_codex.ps1`）は完了まで約15〜30秒を要するため、非同期タスク待ち（`schedule` タイマー条件付与）を利用したフローが極めて安定する。
- マージ済みコミットを amend してしまい、push 不能な分岐が発生した。修正は新規コミットで積むべきだった。


