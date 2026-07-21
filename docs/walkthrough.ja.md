# ウォークスルー: `/startproject` フルサイクル実行ログ

このドキュメントは、**Antigravity Orchestra** の `/startproject` ワークフローを Antigravity CLI (`agy`) と OpenAI Codex CLI (`codex`) の実際のやり取りログ（トランスクリプト抜粋）とともに順を追って解説するガイドです。

---

## 1. 事前準備と環境診断

開発や機能追加を開始する前に、環境診断スクリプトを実行してツールのインストール状況およびディレクトリ配置を確認します。

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

**実際の実行出力**:
```text
=== Antigravity Orchestra Doctor ===
Repo root: <repo-root>

[OK  ] Codex CLI: <path-to-codex>\codex.exe (codex-cli 0.144.6)
[OK  ] Codex auth: Logged in using ChatGPT
[OK  ] Antigravity CLI: <path-to-agy>\agy.exe (v1.1.5)
[OK  ] Layout: AGENTS.md
[OK  ] Layout: .agents\rules
[OK  ] Layout: .agents\skills\codex-system\SKILL.md
[OK  ] Layout: .agents\skills\codex-system\scripts\ask_codex.ps1
[OK  ] Layout: .agents\skills\codex-system\scripts\review.ps1
[OK  ] Layout: .agents\skills\codex-system\scripts\CodexHelpers.psm1
[OK  ] Layout: .agents\workflows
[OK  ] Layout: .codex\AGENTS.md
[OK  ] Layout: logs\codex-responses
[OK  ] .gitignore excludes logs/codex-responses

Result: all checks passed (0 WARN).
```

---

## 2. `/startproject` 6 フェーズのワークフロー

ここでは、`/startproject` を使用して `examples/demo-todo/` 配下に簡単な Python CLI TODO アプリを開発した例を示します。

### Phase 1: リサーチ（Antigravity）
要件、プロジェクト構造、ライブラリの選定方針を調査し、結果を `docs/research/demo_todo.md` に保存します。

### Phase 2: 要件定義・ドラフト計画（Antigravity）
スコープ（`add`, `list`, `complete` サブコマンド）、データ構造（`tasks.json`）、Python 標準ライブラリ（`argparse`, `json`, `unittest`）の制約を整理します。

### Phase 3: 設計レビュー（Codex CLI へ委譲）
`ask_codex.ps1` スクリプトを使用して、計画のドラフトを Codex CLI に委譲・検証します。

```powershell
.\.agents\skills\codex-system\scripts\ask_codex.ps1 -Mode "design" `
    -Question "Review implementation plan for demo-todo CLI app" `
    -Context "(ドラフト計画の詳細...)"
```

**Codex レビューログ（抜粋）**:
```text
=== Consulting Codex CLI (design) ===
Question: Review implementation plan for demo-todo CLI app

1. Plan Assessment:
   - TaskManager と CLI インターフェースが清潔に分離されている。
2. Risk Analysis:
   - ファイル書き込み中断対策: 一時ファイルと os.replace によるアトミック更新を採用すること。
   - JSON 破損対策: 壊れたデータファイルを空リストで勝手に上書き破壊しないこと。
   - ID 自動採番: 連番整数 (max(id) + 1) を使用すること。
3. Refinements:
   - エラーハンドリング: 不正 ID やファイル破損時は stderr に出力し exit(1) で終了。
   - テスト隔離のための db_path 注入シームを設けること。
```

### Phase 4: タスクリスト作成（Antigravity）
リサーチ結果、要件、Codex のフィードバックを統合し、具体的なタスクリストを作成します。

### Phase 5: ドキュメント更新（Antigravity）
`docs/DESIGN.md` の `## 設計決定履歴` にアーキテクチャの決定事項を記録します。

### Phase 6: 実装と品質保証（Antigravity + Codex）
`examples/demo-todo/todo.py` およびテスト `examples/demo-todo/test_todo.py` を実装し、テスト実行後に `review.ps1` でレビューを通します。

---

## 3. `review.ps1` による自動コードレビュー

未コミットの全変更（staged / unstaged / untracked）を `review.ps1` でチェックします。

```powershell
.\.agents\skills\codex-system\scripts\review.ps1
```

**Codex レビューログ（抜粋）**:
```text
=== Consulting Codex CLI (review) ===

1. Verification of Previous Findings
   - [P1] CLI テストの環境隔離: 修正完了（テスト側で db_path を注入）。
   - [P1] テスト発見コマンド仕様: 修正完了（docs/DESIGN.md のコマンドを更新）。
   - [P2] データ保護: 修正完了（JSON 破損時に RuntimeError を発生）。

2. Summary & Recommendation
   - 単体テスト全 9 件パス。
   - コミット承認 (Approved for commit)。
```

---

## 4. 動作検証コマンド

単体テストを実行し、全 9 件のテストがパスすることを確認します：

```powershell
python -m unittest discover -s examples/demo-todo
```

出力:
```text
.........
----------------------------------------------------------------------
Ran 9 tests in 0.020s

OK
```

---

## 5. 次の一歩

本テンプレートの協調構成をご自身のプロジェクトに導入する手順：

1. `.agents/`, `.codex/`, `AGENTS.md` をプロジェクトルートにコピーします。
2. `.\.agents\skills\codex-system\scripts\check.ps1` を実行して初期診断を行います。
3. エージェントへの指示で `/startproject` または `/plan` ワークフローを開始します。
