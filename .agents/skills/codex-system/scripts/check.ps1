#requires -Version 5.1
# 環境診断スクリプト（doctor）
# 使用方法: .\check.ps1
#
# セットアップの前提が揃っているかを OK / WARN / FAIL で列挙する。
# FAIL が 1 件でもあれば exit 1（WARN のみなら exit 0）。

param(
    # 省略時は PATH から自動解決
    [string]$CodexPath = ""
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot 'CodexHelpers.psm1') -Force

$repoRoot = Get-CodexRepoRoot -ScriptRoot $PSScriptRoot
$failCount = 0
$warnCount = 0

function Write-Check {
    param([string]$Level, [string]$Message)
    $color = switch ($Level) {
        'OK'   { 'Green' }
        'WARN' { 'Yellow' }
        'FAIL' { 'Red' }
    }
    Write-Host ("[{0,-4}] {1}" -f $Level, $Message) -ForegroundColor $color
}

Write-Host "=== Antigravity Orchestra Doctor ===" -ForegroundColor Cyan
Write-Host "Repo root: $repoRoot"
Write-Host ""

# Native プローブ用ヘルパー。$ErrorActionPreference=Stop +
# $PSNativeCommandUseErrorActionPreference 環境で非ゼロ exit が
# 例外化して診断が途中終了しないよう、Continue で包んで実行する。
function Invoke-Probe {
    param([string]$Exe, [string[]]$ProbeArgs)
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& $Exe @ProbeArgs 2>&1 | Out-String).Trim()
        [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = $out }
    } finally {
        $ErrorActionPreference = $savedEap
    }
}

# 1. Codex CLI の存在（--version が失敗する壊れたバイナリは FAIL）
try {
    $codex = Resolve-CodexCli -Override $CodexPath
    $probe = Invoke-Probe -Exe $codex -ProbeArgs @('--version')
    if ($probe.ExitCode -eq 0) {
        Write-Check 'OK' "Codex CLI: $codex ($(($probe.Output -split "`n")[0]))"
    } else {
        Write-Check 'FAIL' "Codex CLI at $codex exists but '--version' failed (exit $($probe.ExitCode)): $($probe.Output)"
        $failCount++
        $codex = $null
    }
} catch {
    Write-Check 'FAIL' $_.Exception.Message
    $failCount++
    $codex = $null
}

# 2. Codex の認証状態（login status が非対応の CLI もあるため WARN 止まり）
if ($codex) {
    $auth = Invoke-Probe -Exe $codex -ProbeArgs @('login', 'status')
    if ($auth.ExitCode -eq 0) {
        Write-Check 'OK' "Codex auth: $($auth.Output)"
    } else {
        Write-Check 'WARN' "Codex auth not confirmed (run 'codex login'): $($auth.Output)"
        $warnCount++
    }
}

# 3. Antigravity CLI（agy）の存在（IDE のみの利用も許容するため WARN 止まり）
$agy = Get-Command agy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($agy) {
    $agyProbe = Invoke-Probe -Exe $agy.Source -ProbeArgs @('--version')
    if ($agyProbe.ExitCode -eq 0) {
        Write-Check 'OK' "Antigravity CLI: $($agy.Source) (v$(($agyProbe.Output -split "`n")[0]))"
    } else {
        Write-Check 'WARN' "Antigravity CLI at $($agy.Source) exists but '--version' failed (exit $($agyProbe.ExitCode))"
        $warnCount++
    }
} else {
    Write-Check 'WARN' "Antigravity CLI (agy) not found on PATH. Install from https://antigravity.google (or use the Antigravity IDE)."
    $warnCount++
}

# 4. テンプレートレイアウト
$requiredPaths = @(
    'AGENTS.md',
    '.agents\rules',
    '.agents\skills\codex-system\SKILL.md',
    '.agents\skills\codex-system\scripts\ask_codex.ps1',
    '.agents\skills\codex-system\scripts\review.ps1',
    '.agents\skills\codex-system\scripts\CodexHelpers.psm1',
    '.agents\workflows',
    '.codex\AGENTS.md',
    'logs\codex-responses'
)
foreach ($rel in $requiredPaths) {
    $full = Join-Path $repoRoot $rel
    if (Test-Path $full) {
        Write-Check 'OK' "Layout: $rel"
    } else {
        Write-Check 'FAIL' "Layout: $rel is missing"
        $failCount++
    }
}

# 5. .gitignore がログを除外しているか
$gitignore = Join-Path $repoRoot '.gitignore'
if ((Test-Path $gitignore) -and (Select-String -Path $gitignore -Pattern 'logs/codex-responses' -Quiet)) {
    Write-Check 'OK' ".gitignore excludes logs/codex-responses"
} else {
    Write-Check 'WARN' ".gitignore does not exclude logs/codex-responses (private prompts could be committed)"
    $warnCount++
}

Write-Host ""
if ($failCount -gt 0) {
    Write-Host "Result: $failCount FAIL / $warnCount WARN — fix the FAIL items above." -ForegroundColor Red
    exit 1
}
Write-Host "Result: all checks passed ($warnCount WARN)." -ForegroundColor Green
exit 0
