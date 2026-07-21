# Development Environment Rule

開発環境に関するルール。

## 推奨ツール

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

### Python

```bash
# uv を使用
uv pip install package-name
uv pip freeze > requirements.txt
```

### Node.js

```bash
# pnpm を使用
pnpm add package-name
pnpm add -D dev-package-name
```

## 注意事項

- パス区切り文字に注意（`\` vs `/`）
- 改行コードの違いに注意（CRLF vs LF）
