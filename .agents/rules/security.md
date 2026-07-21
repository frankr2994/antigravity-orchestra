# Security Rule

セキュリティに関するルール。

## 機密情報の管理

### 絶対にコードに含めないもの

- API キー、トークン
- パスワード
- データベース接続文字列
- 秘密鍵

### 対策

1. **環境変数を使用**

```python
import os
api_key = os.environ.get("API_KEY")
```

2. **.env ファイルを .gitignore に追加**

```gitignore
.env
.env.local
*.pem
*.key
```

3. **シークレット管理サービスを使用**（本番環境）

## 入力検証

### すべての外部入力を検証

```python
# 良い例
def process_user_input(data: str) -> str:
    if not data:
        raise ValueError("Input is required")
    if len(data) > 1000:
        raise ValueError("Input too long")
    # サニタイズ
    return sanitize(data)

# 悪い例
def process_user_input(data):
    return data  # 検証なし
```

### SQL インジェクション対策

```python
# 良い例（パラメータ化クエリ）
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))

# 悪い例（文字列結合）
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```

## 依存関係のセキュリティ

### 定期的なアップデート

```bash
# 脆弱性チェック
pip-audit  # Python
npm audit  # Node.js
```

### 信頼できるソースのみ使用

- 公式パッケージレジストリを使用
- ダウンロード数、メンテナンス状況を確認

## Codex CLI のセキュリティ

### sandbox モード

Codex CLI は `--sandbox read-only` で実行する：

```bash
codex exec --sandbox read-only "..."
```

これにより：
- ファイルの読み取りのみ可能
- ファイルの書き込み不可
- システムコマンドの実行制限

## レビュー時のセキュリティチェック

Codex にレビューを依頼する際に含める：

```
Check for security issues:
1. Hardcoded credentials
2. SQL injection vulnerabilities
3. XSS vulnerabilities
4. Insecure dependencies
5. Improper error handling (information leakage)
```
