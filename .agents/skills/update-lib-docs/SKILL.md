---
name: update-lib-docs
description: Use this skill to document library constraints, usage patterns, and gotchas in docs/libraries/
---

# Update Library Docs Skill

ライブラリの制約、使用パターン、注意点を文書化する。

## いつ使うか

- 新しいライブラリを導入したとき
- ライブラリの制約を発見したとき
- ライブラリの使い方でハマったとき
- バージョン固有の注意点があるとき

## 使わないとき

- 一般的な使い方（公式ドキュメントで十分）
- 設計判断（→ design-tracker を使用）

## 出力先

`docs/libraries/{library-name}.md`

## フォーマット

```markdown
# {ライブラリ名}

バージョン: {使用バージョン}
最終更新: {日付}

## 概要
{ライブラリの目的と用途}

## インストール
```bash
{インストールコマンド}
```

## 基本的な使い方
{コード例}

## 制約・注意点

### {制約1}
{詳細と回避策}

### {制約2}
{詳細と回避策}

## プロジェクト固有の設定
{このプロジェクトでの設定内容}

## 参考リンク
- 公式ドキュメント: {URL}
- GitHub: {URL}
```

## 例

```markdown
# axios

バージョン: 1.6.0
最終更新: 2026-02-02

## 概要
HTTP クライアントライブラリ

## 制約・注意点

### タイムアウトのデフォルト値
デフォルトではタイムアウトが設定されていない。
必ず明示的に設定すること。

```javascript
axios.create({
  timeout: 10000, // 10秒
});
```

### エラーハンドリング
ネットワークエラーとHTTPエラーの区別が必要。

```javascript
try {
  await axios.get('/api');
} catch (error) {
  if (error.response) {
    // HTTPエラー（4xx, 5xx）
  } else if (error.request) {
    // ネットワークエラー
  }
}
```
```
