#requires -Version 5.1
# Codex CLI レビュースクリプト（Windows ネイティブ codex CLI 用）
# 使用方法: .\review.ps1
#
# 前提: codex CLI がインストール済みで PATH が通っていること（`codex --version` で確認）。
# モデルは ~/.codex/config.toml の設定を継承する。-Model で上書き可能。
#
# `codex exec review --uncommitted` を使用し、staged/unstaged/untracked の
# 変更を対象に決定的にレビューする（「最近の変更」という曖昧なプロンプトにしない）。
# -BaseRef を指定すると、代わりに指定ブランチとの差分をレビューする。

param(
    [string]$Model = "",
    [string]$CodexPath = "",
    [string]$LogDir = "",
    [string]$BaseRef = ""
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot 'CodexHelpers.psm1') -Force

$repoRoot = Get-CodexRepoRoot -ScriptRoot $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $repoRoot 'logs/codex-responses'
}

Write-Host "=== Starting Codex Review ===" -ForegroundColor Cyan
if (-not [string]::IsNullOrWhiteSpace($BaseRef)) {
    Write-Host "Scope: changes against '$BaseRef'" -ForegroundColor Yellow
} else {
    Write-Host "Scope: staged + unstaged + untracked changes" -ForegroundColor Yellow
}
Write-Host ""

Invoke-CodexReview -RepoRoot $repoRoot -Model $Model -CodexPath $CodexPath `
    -LogDir $LogDir -BaseRef $BaseRef | Out-Null
