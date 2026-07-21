# プロジェクト設計ドキュメント

このドキュメントはプロジェクトの設計決定を記録します。

## 概要

Antigravity Orchestra ワークスペースにおけるマルチエージェント協調開発（/startproject ワークフロー）のドッグフーディング用サンプル機能 `demo-todo` CLI アプリケーションの設計。

## アーキテクチャ

```
[CLI / argparse] -> [TaskManager] -> [Atomic File Write (os.replace)] -> tasks.json
```

## 技術スタック

| カテゴリ | 技術 | 理由 |
|----------|------|------|
| 言語 | Python 3.10+ | 標準ライブラリのみで動作し、追加依存関係が不要なため |
| CLI パーサー | argparse | 標準ライブラリ |
| データ保存 | JSON (`json`, `pathlib`, `os`) | 視認性が高く扱いやすいため |
| テスト | unittest | 標準ライブラリ |

## 設計決定履歴

<!-- 新しい決定は上に追加 -->

### 2026-07-21: demo-todo CLI アプリケーションの基本設計

**背景**: /startproject ワークフローのフルサイクル検証（ドッグフーディング Plan 001）のため、標準的で隔離された CLI TODO アプリを開発する。

**決定**:
1. Python 標準ライブラリのみを使用（`examples/demo-todo/`）。
2. CLI インターフェースは `add`, `list`, `complete` の 3 コマンド。
3. `TaskManager` によるビジネスロジック分離と `os.replace` によるアトミックファイル書き込み。
4. 単体テストは `unittest` を使用し、一時ディレクトリ上でテストデータを作成。

**理由**: Codex CLI の設計レビューによる指摘（アトミックライト、ID自動採番、単一責任原則）を反映。

**代替案**:
- Third-party ライブラリ (`click`, `typer`, `pydantic`) の利用: 外部依存が増えるため不採用。
- Positional ID Index: タスク完了/削除時のインデックスズレのリスクがあるため、自動インクリメント ID を採用。

**影響**: `examples/demo-todo/` 配下に保守しやすくテスト可能なコード基盤が完成する。

---

## 制約事項

- `examples/demo-todo/` 以外のリポジトリコアコードや `.agents/` ルールを変更してはならない。
- テストは標準ライブラリ `python -m unittest discover` で完全実行可能であること。

## 参考資料

- `docs/research/demo_todo.md`

