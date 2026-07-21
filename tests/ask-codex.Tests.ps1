#requires -Version 5.1
# Pester 5 tests for ask_codex.ps1.
# The script calls `exit`, so it must be invoked as a genuine child process
# (pwsh -File) rather than dot-sourced — dot-sourcing would terminate the
# Pester runner itself on the first `exit`.

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\.agents\skills\codex-system\scripts\ask_codex.ps1')).Path
    $script:FixtureSuccess = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-success.ps1')).Path
    $script:FixtureFail = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-fail.ps1')).Path
    $script:FixtureEmpty = (Resolve-Path (Join-Path $PSScriptRoot 'fixtures\fake-codex-empty.ps1')).Path

    function Invoke-AskCodex {
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

Describe 'ask_codex.ps1' {

    It 'exits 1 with a clear message when -CodexPath does not exist' {
        $r = Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'hi'; CodexPath = 'C:\definitely\not\here.exe' }
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'Codex CLI not found'
    }

    It 'fails before invoking codex when -Question is empty' {
        $logDir = Join-Path $TestDrive 'logs-empty-question'
        $r = Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = ''; CodexPath = $script:FixtureSuccess; LogDir = $logDir }
        $r.ExitCode | Should -Not -Be 0
        (Test-Path $logDir) | Should -BeFalse
    }

    It 'creates the log directory and writes a response file on success' {
        $logDir = Join-Path $TestDrive 'logs-basic'
        $r = Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'Reply PONG'; CodexPath = $script:FixtureSuccess; LogDir = $logDir }
        $r.ExitCode | Should -Be 0
        (Test-Path $logDir) | Should -BeTrue
        (Get-ChildItem $logDir -Filter 'analyze-*.md').Count | Should -Be 1
    }

    It 'passes the question through stdin intact (quotes, apostrophes, newlines)' {
        $logDir = Join-Path $TestDrive 'logs-stdin'
        $q = "It's a 'test' with `"quotes`" and newline`ncontinued"
        $r = Invoke-AskCodex -Params @{ Mode = 'debug'; Question = $q; CodexPath = $script:FixtureSuccess; LogDir = $logDir }
        $r.ExitCode | Should -Be 0
        $file = Get-ChildItem $logDir -Filter 'debug-*.md' | Select-Object -First 1
        $content = Get-Content $file.FullName -Raw
        $content | Should -Match ([regex]::Escape($q))
    }

    It 'omits --model by default and includes it when -Model is passed' {
        $logDirDefault = Join-Path $TestDrive 'logs-model-default'
        Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'q'; CodexPath = $script:FixtureSuccess; LogDir = $logDirDefault } | Out-Null
        $fileDefault = Get-ChildItem $logDirDefault -Filter 'analyze-*.md' | Select-Object -First 1
        (Get-Content $fileDefault.FullName -Raw) | Should -Not -Match '--model'

        $logDirModel = Join-Path $TestDrive 'logs-model-set'
        Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'q'; CodexPath = $script:FixtureSuccess; LogDir = $logDirModel; Model = 'gpt-test' } | Out-Null
        $fileModel = Get-ChildItem $logDirModel -Filter 'analyze-*.md' | Select-Object -First 1
        (Get-Content $fileModel.FullName -Raw) | Should -Match '--model\|gpt-test'
    }

    It 'exits 1 and writes an .err.log when codex exits non-zero' {
        $logDir = Join-Path $TestDrive 'logs-fail'
        $r = Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'q'; CodexPath = $script:FixtureFail; LogDir = $logDir }
        $r.ExitCode | Should -Be 1
        (Get-ChildItem $logDir -Filter '*.err.log').Count | Should -Be 1
    }

    It 'exits 1 when codex exits 0 but produces an empty response' {
        $logDir = Join-Path $TestDrive 'logs-empty-response'
        $r = Invoke-AskCodex -Params @{ Mode = 'analyze'; Question = 'q'; CodexPath = $script:FixtureEmpty; LogDir = $logDir }
        $r.ExitCode | Should -Be 1
    }

    It 'preserves Japanese text through stdin under Windows PowerShell 5.1' -Skip:(-not (Get-Command powershell.exe -ErrorAction SilentlyContinue)) {
        $logDir = Join-Path $TestDrive 'logs-ps51-ja'
        $q = 'これは日本語のテスト質問です'
        $argList = @('-NoProfile', '-NonInteractive', '-File', $script:ScriptPath,
            '-Mode', 'analyze', '-Question', $q, '-CodexPath', $script:FixtureSuccess, '-LogDir', $logDir)
        & powershell.exe @argList 2>&1 | Out-Null
        $LASTEXITCODE | Should -Be 0
        $file = Get-ChildItem $logDir -Filter 'analyze-*.md' | Select-Object -First 1
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $content | Should -Match ([regex]::Escape($q))
        $content | Should -Not -Match ([regex]::Escape('??????'))
    }

    It 'defaults LogDir and --cd to the repo root, not the caller''s working directory' {
        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
        $defaultLogDir = Join-Path $repoRoot 'logs\codex-responses'
        # 'analyze-*' (all extensions) so cleanup also removes the .combined.log
        # diagnostics the script writes alongside the response.
        $before = @(Get-ChildItem $defaultLogDir -Filter 'analyze-*' -ErrorAction SilentlyContinue)

        Push-Location $TestDrive
        try {
            $argList = @('-NoProfile', '-NonInteractive', '-File', $script:ScriptPath,
                '-Mode', 'analyze', '-Question', 'cwd independence check', '-CodexPath', $script:FixtureSuccess)
            $output = & pwsh @argList 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        $after = @(Get-ChildItem $defaultLogDir -Filter 'analyze-*' -ErrorAction SilentlyContinue)
        $newFiles = @($after | Where-Object { $before.FullName -notcontains $_.FullName })
        try {
            $exitCode | Should -Be 0
            $newMd = @($newFiles | Where-Object { $_.Extension -eq '.md' })
            $newMd.Count | Should -Be 1
            (Get-Content $newMd[0].FullName -Raw) | Should -Match ([regex]::Escape($repoRoot))
        } finally {
            $newFiles | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    }
}
