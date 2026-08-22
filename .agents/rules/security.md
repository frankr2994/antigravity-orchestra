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

「外部入力」にはユーザー入力だけでなく、HTTP、プロバイダー JSON、データベース値、
過去に永続化された値、Git/CLI/プロセス出力、URL、パス、ファイル名、環境変数、
設定、リポジトリ内容、モデル出力を含む。TypeScript の型アサーションは検証ではない。

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

## セキュリティ機構と未信頼コード

- OS / プラットフォームの資格情報ストアが要求されている場合、独自暗号化、独自鍵導出、
  マシン情報由来の鍵、独自認証方式で置き換えない
- Git worktree はコード分離であり、セキュリティサンドボックスではない
- クラウド生成コードや未信頼リポジトリコードを Orchestra ホストの全資格情報・全環境で
  直接実行しない。許可リスト化した環境、明示的なファイルシステム/ネットワーク制約、
  プロセスツリー制限を持つ隔離実行環境を使う
- リポジトリ文字列、diff、ファイル名、ツール出力、モデル所見を別モデルのプロンプトへ
  入れる場合、それらを命令ではなくデータとして区切り、構造検証、サイズ制限、秘密情報の
  編集、出所と task/review/SHA の保持を行う
- 秘密情報の編集テストはサンプル文字列のパターンだけでなく、本番のログ・イベント・
  エラー整形経路を実際に通す

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
