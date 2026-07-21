# Coding Principles Rule

コード品質を維持するための原則。

## 基本原則

### 1. シンプルさ（KISS）

- 最もシンプルな解決策を選ぶ
- 将来の要件を過度に予測しない
- 必要になるまで抽象化しない

### 2. 単一責任（SRP）

- 1つの関数は1つのことだけを行う
- 1つのファイルは1つの責任だけを持つ
- 変更理由は1つだけ

### 3. 早期リターン

```python
# 良い例
def process(data):
    if not data:
        return None
    if not data.valid:
        return None
    return data.process()

# 悪い例
def process(data):
    if data:
        if data.valid:
            return data.process()
    return None
```

### 4. 命名規則

- 変数名は意図を表す
- 略語を避ける
- ブール値は `is_`, `has_`, `can_` で始める

```python
# 良い例
is_authenticated = True
user_count = 10
has_permission = False

# 悪い例
auth = True
cnt = 10
perm = False
```

## コードスタイル

### インデント
- スペース4つ（Python）
- スペース2つ（JavaScript/TypeScript）

### 行の長さ
- 最大100文字

### コメント
- 「なぜ」を書く（「何を」はコードが語る）
- 古くなったコメントは削除

## 禁止事項

- マジックナンバー（定数を使う）
- グローバル変数の濫用
- 深いネスト（3階層まで）
- 巨大な関数（50行以内を目安）

## レビュー観点

Codex CLI にレビューを依頼する際のチェックポイント：

1. 単一責任を守っているか
2. 命名は適切か
3. エラーハンドリングは十分か
4. テストしやすい構造か
