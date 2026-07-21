# Codex CLI Agent Configuration

Antigravity Orchestra で使用する Codex CLI の設定。

## 役割

Codex CLI は以下の役割を担当：

- **Designer**: アーキテクチャ設計、実装計画
- **Debugger**: 根本原因分析、複雑なバグ調査
- **Auditor**: コードレビュー、品質チェック

## 実行モード

常に `--sandbox read-only` で実行。モデルは `~/.codex/config.toml` の設定を継承する
（固定したい場合のみ `--model` を付ける）。プロンプトは stdin 経由で渡す：

```bash
echo "..." | codex exec --sandbox read-only --skip-git-repo-check --color never -
```

## 入力フォーマット

Antigravity から Codex への質問は以下の構造：

```markdown
## Task Type: {analyze|design|debug|review}

## Question
{質問内容}

## Context
{関連ファイルや背景情報}

## Instructions
- Analyze thoroughly before responding
- Provide structured output with clear sections
- Include trade-offs and alternatives where applicable
- Respond in English for reasoning accuracy
```

## 出力フォーマット

Codex の回答は以下の構造を期待：

```markdown
## Analysis
{分析結果}

## Recommendations
{推奨事項}

## Trade-offs
{トレードオフの説明}

## Next Steps
{次のステップ}
```

## 注意事項

- Codex はファイルを編集しない（分析と提案のみ）
- 結果は `logs/codex-responses/` に保存される
- Antigravity がユーザーに日本語で報告する
