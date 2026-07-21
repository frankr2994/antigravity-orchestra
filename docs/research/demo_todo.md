# Research: Demo Todo CLI Application

> Date: 2026-07-21
> Version: Python 3.10+ (Standard Library)

## Summary
- `examples/demo-todo/` 配下にシンプルな Python CLI TODO リストアプリを構築する。
- 外部ライブラリ依存を極力減らし、Python 標準ライブラリ (`argparse`, `json`, `pathlib`, `unittest`) のみで実装可能。
- 機能要求: 追加 (`add`), 一覧 (`list`), 完了 (`complete`) の3機能。
- 永続化: `tasks.json` ファイル。

## Details
### 構造
- `examples/demo-todo/todo.py`: メイン CLI エントリポイント
- `examples/demo-todo/test_todo.py`: `unittest` による単体テスト
- `examples/demo-todo/tasks.json`: 実行時のタスク保存ファイル（gitignore または テスト時隔離）

### データモデル
```json
[
  {
    "id": 1,
    "title": "Buy milk",
    "done": false
  }
]
```

### CLI コマンド仕様
- `python todo.py add "Task description"`
- `python todo.py list`
- `python todo.py complete <id>`

## Recommendations
- 標準ライブラリのみを使用し、インストールの手間なく動作検証可能にする。
- テストコードは一時ファイル/パスをモックまたは `tempfile` / `tmp_path` で隔離し、既存データに影響を与えないようにする。

## Sources
- Python 3 Standard Library Documentation (`argparse`, `json`, `unittest`)

## For Codex Review
- 3機能 (add, list, complete) のインターフェース設計およびエラーハンドリング（不正ID指定時等）の妥当性についてレビューを依頼する。
