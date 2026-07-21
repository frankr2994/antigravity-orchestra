# Testing Rule

テストに関するルール。

## テスト駆動開発（TDD）

### Red-Green-Refactor サイクル

1. **Red**: 失敗するテストを書く
2. **Green**: テストを通す最小限のコードを書く
3. **Refactor**: コードを改善する（テストは通ったまま）

### TDD の原則

- テストを先に書く
- 一度に1つのテストだけ追加
- テストが失敗する理由を確認してから実装

## AAA パターン

テストは **Arrange-Act-Assert** の構造で書く：

```python
def test_user_creation():
    # Arrange（準備）
    name = "John"
    email = "john@example.com"
    
    # Act（実行）
    user = User.create(name=name, email=email)
    
    # Assert（検証）
    assert user.name == name
    assert user.email == email
```

## テストの種類

| 種類 | 範囲 | 速度 | 割合 |
|------|------|------|------|
| Unit | 関数・クラス | 高速 | 70% |
| Integration | 複数コンポーネント | 中速 | 20% |
| E2E | システム全体 | 低速 | 10% |

## カバレッジ目標

- 新規コード: 80% 以上
- 重要なビジネスロジック: 100%
- ユーティリティ関数: 100%

## テストの命名規則

```python
# パターン: test_{何を}_{条件}_{期待結果}
def test_login_with_valid_credentials_returns_token():
    pass

def test_login_with_invalid_password_raises_error():
    pass
```

## モック・スタブの使用

外部依存はモック化する：

```python
from unittest.mock import Mock, patch

@patch('module.external_api')
def test_with_mocked_api(mock_api):
    mock_api.return_value = {"status": "ok"}
    result = function_under_test()
    assert result == expected
```

## テスト設計は Codex に委譲

テストケースの設計は Codex CLI に委譲する：

```
/tdd ログイン機能
```

Codex が考慮すること：
- 正常系
- 異常系
- 境界値
- エッジケース

## 禁止事項

- テストなしでコードをマージしない
- テストをスキップしない（一時的でも）
- テスト間の依存関係を作らない
- 本番環境に影響するテストを書かない
