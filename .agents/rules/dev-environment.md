# Development Environment Rule

開発環境に関するルール。

## リポジトリ既定ツールを優先

既存プロジェクトでは、リポジトリが選択済みのツールとロックファイルを使う。
明示的な移行判断なしにパッケージマネージャー、ロックファイル、テストランナー、
フォーマッターを追加・置換しない。

- `package-lock.json` → npm（クリーンインストールは `npm ci`）
- `pnpm-lock.yaml` → pnpm
- `yarn.lock` → Yarn
- `uv.lock` → uv
- `poetry.lock` → Poetry
- `requirements*.txt` → 既存の pip 系ワークフロー

以下は、新規プロジェクトで選択肢が未決定の場合の推奨値とする。

## 新規プロジェクトの推奨ツール

### Python プロジェクト

| ツール | 用途 |
|--------|------|
| **uv** | パッケージ管理（pip より高速） |
| **ruff** | リンター＆フォーマッター |
| **pytest** | テストフレームワーク |
| **mypy** | 型チェック |

### JavaScript/TypeScript プロジェクト

| ツール | 用途 |
|--------|------|
| **pnpm** | パッケージ管理（npm より高速） |
| **ESLint** | リンター |
| **Prettier** | フォーマッター |
| **Vitest** | テストフレームワーク |

## 環境構成

### Windows ネイティブ

```
Windows (PowerShell)
    │
    ├── Antigravity CLI (agy) ← 標準インターフェース（IDE でも可）
    │
    └── Codex CLI (Windows ネイティブ、PATH 経由で解決)
```

### パス設定

Codex CLI は Windows ネイティブで動作するため、パス変換は不要。
`codex --version` が通れば追加設定なしでスクリプトが動作する。

## 環境変数

機密情報は `.env` ファイルで管理し、Git にコミットしない。

```bash
# .env（Git にコミットしない）
OPENAI_API_KEY=sk-xxxxx
DATABASE_URL=postgresql://...
```

```bash
# .env.example（Git にコミット）
OPENAI_API_KEY=your-api-key-here
DATABASE_URL=your-database-url-here
```

## 依存関係の管理

### Python（uv を採用済みの場合）

```bash
# uv を使用
uv pip install package-name
uv pip freeze > requirements.txt
```

### Node.js（pnpm を採用済みの場合）

```bash
# pnpm を使用
pnpm add package-name
pnpm add -D dev-package-name
```

## 注意事項

- パス区切り文字に注意（`\` vs `/`）
- 改行コードの違いに注意（CRLF vs LF）
