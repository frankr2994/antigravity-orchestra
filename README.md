# 🎼 Antigravity Orchestra

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue.svg)](#前提条件)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Sora-bluesky/antigravity-orchestra/issues)

**🌐 Language: 日本語 | [English](README.en.md)**

---

**Antigravity Orchestra** は、[Google Antigravity](https://antigravity.google)（Gemini）と [OpenAI Codex CLI](https://github.com/openai/codex) を協調させるマルチエージェント開発テンプレートです。

[Claude Code Orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra)（@mkj / 松尾研究所）にインスパイアされています。

---

## ✨ これは何？

```
┌─────────────────────────────────────────────────────────────┐
│                      ユーザー                               │
│                         │                                  │
│                         ▼                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │    Google Antigravity (Orchestrator + Researcher)     │  │
│  │    → Gemini / 大容量コンテキスト                      │  │
│  │    → ユーザー対話・リサーチ・実装を担当               │  │
│  │                                                       │  │
│  │        ┌─────────────────────────────────────────┐    │  │
│  │        │   Codex CLI (Skills の scripts/ 経由)   │    │  │
│  │        │   → 設計・デバッグ・レビューを担当      │    │  │
│  │        └─────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**インターフェースは Antigravity だけ。** ユーザーは Antigravity CLI（`agy`）とだけ対話し、必要に応じて Antigravity が Codex に相談します。同じ設定で Antigravity IDE でも動作します。

---

## 🎯 こんな人におすすめ

- Antigravity を使っているが、設計やレビューの品質を上げたい
- 複数の AI を使い分けるのが面倒
- Google と OpenAI、2社の AI の視点でチェックしたい

---

## 🎭 役割分担

| 役割 | 担当 | タスク |
|------|------|--------|
| **Orchestrator** | Antigravity | ユーザー対話、タスク管理、ワークフロー制御 |
| **Researcher** | Antigravity | ライブラリ調査、ドキュメント検索（大容量コンテキスト活用） |
| **Builder** | Antigravity | Codex の設計に基づくコード実装、ファイル編集 |
| **Designer** | Codex CLI | アーキテクチャ設計、実装計画、トレードオフ分析 |
| **Debugger** | Codex CLI | 根本原因分析、複雑なバグ調査 |
| **Auditor** | Codex CLI | コードレビュー、品質チェック、TDD設計 |

---

## 📋 前提条件

| 必要なもの | 確認方法 | 備考 |
|-----------|----------|------|
| Antigravity CLI (`agy`) | PowerShell で `agy --version` | [公式サイト](https://antigravity.google)（IDE でも可） |
| Codex CLI | PowerShell で `codex --version` | [公式インストーラー](https://learn.chatgpt.com/docs/codex/cli)（下記）。npm 経路（`npm i -g @openai/codex`、要 Node.js）も可 |
| Codex の認証 | `codex login` でサインイン | 対応する ChatGPT プランまたは API キー |

---

## 🚀 クイックスタート

### Step 1: テンプレートの取得

PowerShell で実行：

```powershell
# プロジェクトフォルダに移動
cd C:\Users\あなたのユーザー名\Documents\Projects

# テンプレートをクローン
git clone https://github.com/Sora-bluesky/antigravity-orchestra.git my-project

# プロジェクトに移動
cd my-project
```

### Step 2: Codex CLI の確認

PowerShell で Codex CLI が使えることを確認：

```powershell
codex --version   # バージョンが表示されれば OK
```

これだけです。スクリプトが PATH から `codex` を自動解決するため、パス設定は不要です。
モデルも `~/.codex/config.toml` の設定を自動的に継承します。

未インストールの場合は[公式インストーラー](https://learn.chatgpt.com/docs/codex/cli)でインストールし、`codex login` で認証してください：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

（Node.js 環境があれば `npm i -g @openai/codex` でも可）

環境全体をまとめて診断するには doctor スクリプトが使えます：

```powershell
.\.agents\skills\codex-system\scripts\check.ps1
```

### Step 3: Antigravity CLI でプロジェクトを開く

プロジェクトフォルダで `agy` を起動：

```powershell
cd C:\Users\あなたのユーザー名\Documents\Projects\my-project
agy
```

ワンショット実行（ヘッドレス）も可能：

```powershell
agy -p "/plan ログイン機能"
```

> **IDE 派の場合**: Antigravity IDE で **File → Open Folder** からこのフォルダを開いても同じ `.agents/` 設定が読み込まれます。

### Step 4: 動作確認

agy のチャットで入力：

```
/startproject Hello World
```

Antigravity が以下を自動的に実行すれば成功です：

1. リポジトリ構造を分析
2. 要件をヒアリング
3. Codex に設計レビューを委譲
4. タスクリストを作成
5. 設計決定を `docs/DESIGN.md` に記録

> 💡 **実際の動作ログ（ウォークスルー）**:
> 実際のやり取りログと Codex の評価結果については [docs/walkthrough.ja.md](docs/walkthrough.ja.md) を参照してください。


---

## 📁 ディレクトリ構成

```
my-project/
├── .agents/
│   ├── workflows/        # 6 ワークフロー
│   │   ├── startproject.md   # メインワークフロー（6フェーズ）
│   │   ├── plan.md           # 実装計画
│   │   ├── tdd.md            # テスト駆動開発
│   │   ├── simplify.md       # リファクタリング
│   │   ├── checkpoint.md     # セッション永続化
│   │   └── init.md           # 初期化
│   │
│   ├── skills/           # 5 スキル
│   │   ├── codex-system/     # Codex CLI 連携
│   │   │   ├── SKILL.md
│   │   │   └── scripts/
│   │   │       ├── ask_codex.ps1     # 相談（analyze/design/debug/review）
│   │   │       ├── review.ps1        # 変更レビュー（codex exec review）
│   │   │       ├── check.ps1         # 環境診断（doctor）
│   │   │       └── CodexHelpers.psm1 # 共有ヘルパー
│   │   ├── design-tracker/
│   │   ├── research/
│   │   ├── update-design/
│   │   └── update-lib-docs/
│   │
│   └── rules/            # 8 ルール
│       ├── delegation-triggers.md  # 自動振り分け（Hooks代替）
│       ├── role-boundaries.md      # 役割境界
│       ├── language.md
│       ├── codex-delegation.md
│       ├── coding-principles.md
│       ├── dev-environment.md
│       ├── security.md
│       └── testing.md
│
├── .codex/               # Codex CLI 設定
│   └── AGENTS.md
│
├── docs/                 # 知識ベース
│   ├── DESIGN.md             # 設計決定記録
│   ├── research/             # リサーチ結果
│   └── libraries/            # ライブラリ制約
│
└── logs/
    └── codex-responses/      # Codex 相談ログ
```

---

## 📖 Workflows の詳細

### /startproject - メインワークフロー（6フェーズ）

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Antigravity (Research)                                │
│  → リポジトリ分析・ライブラリ調査                               │
│  → Output: docs/research/{feature}.md                           │
├─────────────────────────────────────────────────────────────────┤
│  Phase 2: Antigravity (Requirements)                            │
│  → ユーザーから要件ヒアリング（目的、スコープ、制約、成功基準） │
│  → 実装計画のドラフト作成                                       │
├─────────────────────────────────────────────────────────────────┤
│  Phase 3: Codex CLI (Design Review)                             │
│  → Phase 1のリサーチ + Phase 2の計画を読み込み                  │
│  → 計画の深いレビュー・リスク分析・実装順序の提案               │
├─────────────────────────────────────────────────────────────────┤
│  Phase 4: Antigravity (Task Creation)                           │
│  → 全入力を統合                                                 │
│  → タスクリスト作成・ユーザー確認                               │
├─────────────────────────────────────────────────────────────────┤
│  Phase 5: Antigravity (Documentation)                           │
│  → docs/DESIGN.md に設計決定を記録                              │
├─────────────────────────────────────────────────────────────────┤
│  Phase 6: Codex CLI (Quality Assurance)                         │
│  → 実装完了後に Codex でレビュー                                │
│  → 実装バイアスを排除した品質保証                               │
└─────────────────────────────────────────────────────────────────┘
```

### /plan - 実装計画

Codex の支援で詳細な実装計画を作成します。

```
/plan ユーザー認証機能の追加
```

### /tdd - テスト駆動開発

Codex がテストケースを設計し、Antigravity が Red-Green-Refactor サイクルを実行します。

```
/tdd ログイン機能
```

### /simplify - リファクタリング

コードを簡潔化し、可読性を向上させます。

```
/simplify src/auth/login.py
```

### /checkpoint - セッション永続化

セッション状態を保存して後で再開できます。

```
/checkpoint          # 基本: 履歴ログ
/checkpoint --full   # 完全: git履歴・ファイル変更含む
```

---

## 🛠️ Skills の詳細

### codex-system - Codex CLI 連携

設計・デバッグ・レビューを Codex に委譲するための核心スキル。

**トリガーキーワード：**

| 分類 | キーワード |
|------|-----------|
| 設計系 | 「設計」「アーキテクチャ」「どう作る」「design」「architecture」 |
| デバッグ系 | 「なぜ動かない」「エラー」「バグ」「debug」「error」 |
| レビュー系 | 「レビュー」「チェック」「確認」「review」「check」 |

**使わないとき：**
- 単純なファイル編集
- リサーチ・調査（Antigravity 自身が行う）
- ユーザーとの会話

### その他のスキル

| スキル | 用途 |
|--------|------|
| design-tracker | 設計決定を docs/DESIGN.md に追跡・記録 |
| research | ライブラリ調査とドキュメント作成 |
| update-design | DESIGN.md の更新 |
| update-lib-docs | ライブラリ制約の文書化 |

---

## 📏 Rules の詳細

### delegation-triggers.md（最重要）

Claude Code Orchestra の 6つの Hooks を Rules で代替します。

**判断フロー：**

```
ユーザー入力を受け取る
    │
    ▼
【チェック1】設計判断が必要か？
    → Yes: /plan を提案、または codex-system スキルを使用
    │
    ▼
【チェック2】TDDが必要か？
    → Yes: /tdd を提案（Antigravityは直接テスト設計しない）
    │
    ▼
【チェック3】デバッグが必要か？
    → Yes: codex-system スキルを使用
    │
    ▼
【チェック4】実装が完了したか？
    → Yes: codex-system スキルでレビューを提案
    │
    ▼
Antigravity が直接実行（リサーチ、ファイル編集等）
```

### role-boundaries.md（役割境界）

| Antigravity が行うこと | Codex に委譲すること |
|----------------------|---------------------|
| ユーザー対話 | テスト設計（TDD） |
| ライブラリ調査 | アーキテクチャ設計 |
| ファイル編集 | トレードオフ分析 |
| コード実装 | 根本原因分析 |
| | コードレビュー |

**Quick Rule: 「これ、設計の判断が必要？」と思ったら → Codex に委譲**

### その他のルール

| ルール | 内容 |
|--------|------|
| language.md | 思考は英語、ユーザーへの応答は日本語 |
| codex-delegation.md | Codex への委譲ルール詳細 |
| coding-principles.md | シンプルさ、単一責任、早期リターン |
| dev-environment.md | 開発環境設定（uv, ruff, pytest等） |
| security.md | 機密情報管理、入力検証 |
| testing.md | TDD、AAA パターン、カバレッジ目標 |

---

## 💬 基本的な使い方

### 例1: 新機能の開発

```
/startproject ユーザー認証機能
```

Antigravity が自動的に6フェーズを実行します。

### 例2: 設計相談

```
この機能、どう設計すべき？
```

Antigravity が「設計」キーワードを検出し、Codex に委譲します。

### 例3: デバッグ

```
このエラーの原因がわからない
```

Antigravity が根本原因分析を Codex に委譲します。

### 例4: テスト駆動開発

```
/tdd ログイン機能
```

Codex がテストケースを設計し、Antigravity が実装します。

---

## ❓ よくある質問

<details>
<summary><strong>Q: Codex CLI なしでも使えますか？</strong></summary>

はい、ただし設計レビューやデバッグ機能が使えなくなります。Antigravity がすべてを直接処理するため、複雑なプロジェクトでは品質が下がる可能性があります。

</details>

<details>
<summary><strong>Q: なぜ PowerShell スクリプト経由で Codex を呼ぶのですか？</strong></summary>

プロンプトの組み立て・ログ保存・エラー処理を一箇所に集約するためです。スクリプトは PATH 上の `codex` を自動解決し、結果を `logs/codex-responses/` に保存します。

</details>

<details>
<summary><strong>Q: Node.js を再インストールしたらパスはどうなりますか？</strong></summary>

何もする必要はありません。スクリプトは実行のたびに PATH から `codex` を解決するため、再インストールしても `codex --version` が通れば動きます。

</details>

<details>
<summary><strong>Q: ワークフローをカスタマイズできますか？</strong></summary>

はい！`.agents/workflows/` 内のファイルを編集してください。各ワークフローは frontmatter（name, description）とステップバイステップの手順を含む Markdown ファイルです。

</details>

<details>
<summary><strong>Q: ChatGPT Plus と Pro、どちらが必要ですか？</strong></summary>

Plus（$20/月）で十分使えます。Pro（$200/月）はより多くの使用量が必要な場合に検討してください。

</details>

---

## 🔧 トラブルシューティング

| 問題 | 解決策 |
|------|--------|
| Codex スキルが起動しない | 明示的に「Codex に相談して」と依頼、またはキーワード（設計、デバッグ、レビュー）を使用 |
| Codex CLI が見つからないエラー | PowerShell で `codex --version` を確認。未導入なら[公式インストーラー](https://learn.chatgpt.com/docs/codex/cli)を実行 |
| Codex の応答が空 | `codex login` で認証状態を確認 |
| 役割境界が守られない | 明示的に「TDDはCodexに委譲して」と指示 |

---

## ⚠️ 注意事項

- **Google Antigravity は活発に開発中のプロダクトです。** 機能や動作が変更される可能性があります。
- **Codex CLI は ChatGPT サブスクリプションが必要です。** OAuth 認証でサインインします。
- 最新情報は[公式サイト](https://antigravity.google)を確認してください。

---

## 🤝 フィードバック

バグ報告や改善提案は [Issue](https://github.com/Sora-bluesky/antigravity-orchestra/issues) でお願いします。

---

## 🔗 関連リンク

### 参考資料

| 資料 | 著者 | 内容 |
|------|------|------|
| [Claude Code Orchestra](https://zenn.dev/mkj/articles/claude-code-orchestra_20260120) | @mkj（松尾研究所） | マルチエージェント協調の概念 |
| [GitHub: claude-code-orchestra](https://github.com/DeL-TaiseiOzaki/claude-code-orchestra) | DeL-TaiseiOzaki | 実装例 |

### ツール

- [Google Antigravity](https://antigravity.google)
- [OpenAI Codex CLI](https://github.com/openai/codex)

### 関連記事

- [Antigravity インストールガイド](https://zenn.dev/sora_biz/articles/antigravity-windows-install-guide)
- [詳しい使い方（Zenn記事）](https://zenn.dev/sora_biz/articles/antigravity-orchestra-guide)

---

## 📜 ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照してください。

---

## 🙏 謝辞

このプロジェクトは **Claude Code Orchestra**（[@mkj](https://zenn.dev/mkj) / 松尾研究所）にインスパイアされています。マルチエージェント協調のオリジナルアーキテクチャとコンセプトを、Google Antigravity ユーザー向けに移植しました。

---

📅 **最終更新**: 2026年7月21日
