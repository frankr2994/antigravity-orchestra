#requires -Version 5.1
# Pester 5 tests for review.ps1.
# Same rationale as ask-codex.Tests.ps1: the script calls `exit`, so it must
# run as a genuine child process (pwsh -File), not be dot-sourced.

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\.agents\skills\codex-system\scripts\review.ps1')).Path
    $script:FixtureSuccess = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-success.ps1')).Path
    $script:FixtureFail = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-fail.ps1')).Path
    $script:FixtureEmpty = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-empty.ps1')).Path

    function Invoke-Review {
        param([hashtable]$Params)
        $argList = @('-NoProfile', '-NonInteractive', '-File', $script:ScriptPath)
        foreach ($key in $Params.Keys) {
            $argList += "-$key"
            $argList += [string]$Params[$key]
        }
        $output = & pwsh @argList 2>&1
        [PSCustomObject]@{
            ExitCode = $LASTEXITCODE
            Output   = ($output | Out-String)
        }
    }
}

Describe 'review.ps1' {

    It 'exits 1 with a clear message when -CodexPath does not exist' {
        $r = Invoke-Review -Params @{ CodexPath = 'C:\definitely\not\here.exe' }
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'Codex CLI not found'
    }

    It 'creates the log directory and writes a review-*.md file on success' {
        $logDir = Join-Path $TestDrive 'logs-basic'
        $r = Invoke-Review -Params @{ CodexPath = $script:FixtureSuccess; LogDir = $logDir }
        $r.ExitCode | Should -Be 0
        (Get-ChildItem $logDir -Filter 'review-*.md').Count | Should -Be 1
    }

    It 'omits --model by default and includes it when -Model is passed' {
        $logDirDefault = Join-Path $TestDrive 'logs-model-default'
        Invoke-Review -Params @{ CodexPath = $script:FixtureSuccess; LogDir = $logDirDefault } | Out-Null
        $fileDefault = Get-ChildItem $logDirDefault -Filter 'review-*.md' | Select-Object -First 1
        (Get-Content $fileDefault.FullName -Raw) | Should -Not -Match '--model'

        $logDirModel = Join-Path $TestDrive 'logs-model-set'
        Invoke-Review -Params @{ CodexPath = $script:FixtureSuccess; LogDir = $logDirModel; Model = 'gpt-test' } | Out-Null
        $fileModel = Get-ChildItem $logDirModel -Filter 'review-*.md' | Select-Object -First 1
        (Get-Content $fileModel.FullName -Raw) | Should -Match '--model\|gpt-test'
    }

    It 'exits 1 and writes an .err.log when codex exits non-zero' {
        $logDir = Join-Path $TestDrive 'logs-fail'
        $r = Invoke-Review -Params @{ CodexPath = $script:FixtureFail; LogDir = $logDir }
        $r.ExitCode | Should -Be 1
        (Get-ChildItem $logDir -Filter '*.err.log').Count | Should -Be 1
    }

    It 'exits 1 when codex exits 0 but produces an empty response' {
        $logDir = Join-Path $TestDrive 'logs-empty-response'
        $r = Invoke-Review -Params @{ CodexPath = $script:FixtureEmpty; LogDir = $logDir }
        $r.ExitCode | Should -Be 1
    }
}
