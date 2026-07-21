#requires -Version 5.1
# Pester 5 tests for check.ps1 (doctor).
# Runs as a child process (pwsh -File) because the script calls `exit`.

BeforeAll {
    $script:ScriptPath = (Resolve-Path (Join-Path $PSScriptRoot '..\.agents\skills\codex-system\scripts\check.ps1')).Path
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

    function Invoke-Check {
        param([hashtable]$Params = @{})
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

Describe 'check.ps1' {

    It 'reports FAIL and exits 1 when -CodexPath is invalid' {
        $r = Invoke-Check -Params @{ CodexPath = 'C:\definitely\not\here.exe' }
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match 'FAIL'
        $r.Output | Should -Match 'Codex CLI not found'
    }

    It 'verifies the template layout entries' {
        $r = Invoke-Check
        $r.Output | Should -Match 'Layout: AGENTS\.md'
        $r.Output | Should -Match 'Layout: \.agents\\workflows'
        $r.Output | Should -Match 'Layout: logs\\codex-responses'
    }

    It 'checks that .gitignore excludes codex logs' {
        $r = Invoke-Check
        $r.Output | Should -Match '\.gitignore excludes logs/codex-responses'
    }

    It 'detects a missing layout file as FAIL' {
        $target = Join-Path $script:RepoRoot '.codex\AGENTS.md'
        $backup = "$target.bak-test"
        Rename-Item $target $backup
        try {
            $r = Invoke-Check
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match 'Layout: \.codex\\AGENTS\.md is missing'
        } finally {
            Rename-Item $backup $target
        }
    }
}
