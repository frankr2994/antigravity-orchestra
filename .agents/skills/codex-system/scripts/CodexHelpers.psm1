#requires -Version 5.1
# Shared helpers for ask_codex.ps1 / review.ps1. Both scripts are thin
# entry points over this module so CLI-resolution, logging, and error
# handling stay in one place instead of drifting between two copies.
#
# Scope note: `--sandbox read-only` restricts shell commands the model runs,
# but does not by itself disable MCP servers or web search configured in the
# caller's ~/.codex/config.toml — those are a separate mechanism. Treat
# Question/Context content (ask_codex.ps1) as untrusted input to the
# delegated model, same as any other prompt-injection surface.

# BOM-free UTF-8. [System.Text.Encoding]::UTF8 emits a BOM preamble, which
# would prefix stdin sent to codex and get written into log files under
# Windows PowerShell 5.1's `Out-File -Encoding utf8`.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-TextFile {
    # Content is legitimately empty when a run produces no stdout/stderr at
    # all, so it must accept an empty string, not just a non-null one.
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function Resolve-CodexCli {
    param([string]$Override)
    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        if (-not (Test-Path -LiteralPath $Override -PathType Leaf)) {
            throw "Codex CLI not found at '$Override'. Check the -CodexPath value (must be an existing file, not a directory)."
        }
        return (Resolve-Path -LiteralPath $Override).Path
    }
    # -CommandType Application excludes PowerShell functions/aliases that
    # could shadow the real executable (e.g. a profile defining `codex`),
    # while still matching native binaries and npm's .cmd shim on Windows.
    $cmd = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        throw "Codex CLI not found on PATH. Install it with the official installer (irm https://chatgpt.com/codex/install.ps1 | iex — see README), run 'codex login', then verify with 'codex --version'."
    }
    return $cmd.Source
}

function Get-CodexRepoRoot {
    # This module lives at <repo>/.agents/skills/codex-system/scripts/, so the
    # repo root is always 4 levels up from the script's own location. Deriving
    # it this way (instead of Get-Location) keeps behavior correct regardless
    # of the caller's working directory, and keeps default log output inside
    # the repo's .gitignore'd logs/codex-responses/ instead of leaking to
    # wherever the caller happened to be cd'd into.
    param([Parameter(Mandatory=$true)][string]$ScriptRoot)
    # -LiteralPath: a repo under a directory with wildcard characters
    # (e.g. C:\work\[client]\repo) must not be glob-interpreted.
    (Resolve-Path -LiteralPath (Join-Path $ScriptRoot '..\..\..\..')).Path
}

function Invoke-CodexProcess {
    # Shared execution/logging/error-handling tail for both entry points.
    # Runs $Codex with $CodexArgs, optionally piping $StdinInput, and applies
    # the same success/failure rules to both ask_codex.ps1 and review.ps1.
    # On failure this prints an error and calls `exit 1` — treat a call to
    # this function as the caller's last statement on the success path.
    param(
        [Parameter(Mandatory=$true)][string]$Codex,
        [Parameter(Mandatory=$true)][string[]]$CodexArgs,
        [string]$StdinInput = $null,
        [Parameter(Mandatory=$true)][string]$OutputFile,
        [Parameter(Mandatory=$true)][string]$ErrFile,
        [Parameter(Mandatory=$true)][string]$CombinedFile
    )

    # Always pipe something (even an empty string) so the child process gets
    # a closed stdin pipe rather than inheriting an interactive console's
    # open stdin, which could otherwise make it hang waiting for input that
    # will never arrive (codex treats an open stdin as additional context).
    #
    # ErrorActionPreference must be Continue around the native call: on
    # PowerShell 7.3+ with $PSNativeCommandUseErrorActionPreference enabled,
    # a caller's 'Stop' preference would turn a nonzero codex exit into a
    # terminating exception before $LASTEXITCODE / the .err.log branch runs.
    $effectiveStdin = if ($null -ne $StdinInput) { $StdinInput } else { '' }
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # $OutputEncoding must be set in THIS scope: assignments made in the
    # calling function (Invoke-CodexExec etc.) are function-local and not
    # visible here on Windows PowerShell 5.1, which would silently encode
    # non-ASCII stdin (Japanese text) as '?' before it reaches codex.
    $OutputEncoding = $script:Utf8NoBom
    try {
        $execOutput = $effectiveStdin | & $Codex @CodexArgs 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedEap
    }

    # Always persist the full combined stdout+stderr, even on success, so
    # warnings emitted alongside a zero exit code aren't silently lost.
    Write-TextFile -Path $CombinedFile -Content ($execOutput | Out-String)

    if ($exitCode -ne 0) {
        Write-TextFile -Path $ErrFile -Content ($execOutput | Out-String)
        Write-Host "Codex exec failed (exit $exitCode). Full output: $ErrFile" -ForegroundColor Red
        $execOutput | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
        exit 1
    }

    if (-not ((Test-Path -LiteralPath $OutputFile) -and (Get-Item -LiteralPath $OutputFile).Length -gt 0)) {
        Write-Host "Codex exited successfully but produced no response. Run 'codex --version' and check 'codex login' status. Diagnostics: $CombinedFile" -ForegroundColor Red
        exit 1
    }

    Get-Content -LiteralPath $OutputFile -Encoding utf8 | ForEach-Object { Write-Host $_ }
    Write-Host ""
    Write-Host "Response saved to: $OutputFile" -ForegroundColor Gray

    return $OutputFile
}

function Invoke-CodexExec {
    # For free-form questions (ask_codex.ps1): pipes $Prompt via stdin to
    # `codex exec ... -`.
    param(
        [Parameter(Mandatory=$true)][string]$Prompt,
        [Parameter(Mandatory=$true)][string]$FilePrefix,
        [Parameter(Mandatory=$true)][string]$RepoRoot,
        [string]$Model = "",
        [string]$CodexPath = "",
        [Parameter(Mandatory=$true)][string]$LogDir
    )

    [Console]::OutputEncoding = $script:Utf8NoBom
    $OutputEncoding = $script:Utf8NoBom

    try {
        $codex = Resolve-CodexCli -Override $CodexPath
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss_fff"
    $outputFile = Join-Path $LogDir "$FilePrefix-$timestamp-$PID.md"
    $errFile = Join-Path $LogDir "$FilePrefix-$timestamp-$PID.err.log"
    $combinedFile = Join-Path $LogDir "$FilePrefix-$timestamp-$PID.combined.log"

    $codexArgs = @("exec")
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $codexArgs += @("--model", $Model) }
    $codexArgs += @(
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--cd", $RepoRoot,
        "--output-last-message", $outputFile,
        "--color", "never",
        "-"
    )

    return Invoke-CodexProcess -Codex $codex -CodexArgs $codexArgs -StdinInput $Prompt `
        -OutputFile $outputFile -ErrFile $errFile -CombinedFile $combinedFile
}

function Invoke-CodexReview {
    # For review.ps1: uses the official `codex exec review` subcommand
    # instead of a hand-written "review recent changes" prompt, so the scope
    # (staged + unstaged + untracked, or a specific base branch) is explicit
    # and reproducible rather than left to the model's interpretation of
    # "recent". This subcommand doesn't accept a piped prompt or --color.
    param(
        [Parameter(Mandatory=$true)][string]$RepoRoot,
        [string]$Model = "",
        [string]$CodexPath = "",
        [Parameter(Mandatory=$true)][string]$LogDir,
        [string]$BaseRef = ""
    )

    [Console]::OutputEncoding = $script:Utf8NoBom
    $OutputEncoding = $script:Utf8NoBom

    try {
        $codex = Resolve-CodexCli -Override $CodexPath
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }

    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss_fff"
    $outputFile = Join-Path $LogDir "review-$timestamp-$PID.md"
    $errFile = Join-Path $LogDir "review-$timestamp-$PID.err.log"
    $combinedFile = Join-Path $LogDir "review-$timestamp-$PID.combined.log"

    # Flag placement matters: --sandbox and --cd are top-level `exec` options
    # and must come BEFORE the `review` subcommand (after it, the CLI rejects
    # them with "unexpected argument"). --model/--skip-git-repo-check/
    # --output-last-message are declared on the review subcommand itself.
    # --sandbox read-only is passed explicitly so a permissive user config
    # (workspace-write etc.) can never let a delegated review write files.
    $codexArgs = @(
        "exec",
        "--sandbox", "read-only",
        "--cd", $RepoRoot,
        "review"
    )
    if (-not [string]::IsNullOrWhiteSpace($Model)) { $codexArgs += @("--model", $Model) }
    if (-not [string]::IsNullOrWhiteSpace($BaseRef)) {
        $codexArgs += @("--base", $BaseRef)
    } else {
        $codexArgs += @("--uncommitted")
    }
    $codexArgs += @(
        "--skip-git-repo-check",
        "--output-last-message", $outputFile
    )

    return Invoke-CodexProcess -Codex $codex -CodexArgs $codexArgs -StdinInput $null `
        -OutputFile $outputFile -ErrFile $errFile -CombinedFile $combinedFile
}

Export-ModuleMember -Function Resolve-CodexCli, Get-CodexRepoRoot, Invoke-CodexExec, Invoke-CodexReview, Write-TextFile
