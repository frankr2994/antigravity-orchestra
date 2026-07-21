---
name: research
description: Use this skill to conduct research on libraries, APIs, best practices, and document findings in docs/research/
---

# Research Skill

ライブラリ、API、ベストプラクティスを調査し、結果を文書化する。

## いつ使うか

- 新しいライブラリの使用を検討するとき
- APIの仕様を調査するとき
- ベストプラクティスを確認するとき
- 技術的な選択肢を比較するとき

## 使わないとき

- 既に調査済みの内容
- 設計判断が必要なとき（→ codex-system を使用）

## 調査手順

1. **目的の明確化**: 何を知りたいのか
2. **情報収集**: 公式ドキュメント、GitHub、技術ブログ
3. **評価**: メリット・デメリットの整理
4. **文書化**: `docs/research/{topic}.md` に保存

## 出力フォーマット

`docs/research/{topic}.md`:

```markdown
# {トピック} リサーチ

調査日: {日付}

## 概要
{1-2文での要約}

## 調査目的
{なぜ調査が必要か}

## 調査結果

### {項目1}
{詳細}

### {項目2}
{詳細}

## 評価

| 観点 | 評価 | 備考 |
|------|------|------|
| {観点1} | {評価} | {備考} |

## 結論
{推奨事項}

## 参考資料
- {URL1}
- {URL2}
```

## 注意事項

- Antigravity 自身が調査を行う（Codex には委譲しない）
- 1Mトークンコンテキストを活用して広範囲を分析
- 調査結果は必ずファイルに保存
