#requires -Version 5.1
# Codex CLI 相談スクリプト（Windows ネイティブ codex CLI 用）
# 使用方法: .\ask_codex.ps1 -Mode "analyze" -Question "質問内容"
#
# 前提: codex CLI がインストール済みで PATH が通っていること（`codex --version` で確認）。
# モデルは ~/.codex/config.toml の設定を継承する。-Model で上書き可能。

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("analyze", "design", "debug", "review")]
    [string]$Mode,

    [Parameter(Mandatory=$true)]
    [ValidateNotNullOrEmpty()]
    [string]$Question,

    [string]$Context = "",

    # 省略時は ~/.codex/config.toml のデフォルトモデルを使用
    [string]$Model = "",

    # 省略時は PATH から自動解決
    [string]$CodexPath = "",

    # 省略時はリポジトリ直下の logs/codex-responses（呼び出し元のカレントディレクトリに依存しない）
    [string]$LogDir = ""
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot 'CodexHelpers.psm1') -Force

$repoRoot = Get-CodexRepoRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $repoRoot 'logs/codex-responses'
}

$prompt = @"
## Task Type: $Mode

## Question
$Question

## Context
$Context

## Instructions
- Analyze thoroughly before responding
- Provide structured output with clear sections
- Include trade-offs and alternatives where applicable
- Respond in English for reasoning accuracy
"@

Write-Host "=== Consulting Codex CLI ($Mode) ===" -ForegroundColor Cyan
Write-Host "Question: $Question" -ForegroundColor Yellow
Write-Host ""

Invoke-CodexExec -Prompt $prompt -FilePrefix $Mode -RepoRoot $repoRoot `
    -Model $Model -CodexPath $CodexPath -LogDir $LogDir | Out-Null
