#requires -Version 5.1
# Test fixture: stands in for the real `codex` CLI via -CodexPath.
# Echoes received args and stdin into the file passed after --output-last-message,
# so tests can assert on how ask_codex.ps1 / review.ps1 built the invocation.

$stdin = ($input | Out-String)

$outputIndex = [Array]::IndexOf($args, '--output-last-message')
if ($outputIndex -ge 0 -and $outputIndex + 1 -lt $args.Count) {
    $outputFile = $args[$outputIndex + 1]
    $body = "STDIN:$stdin`nARGS:$($args -join '|')"
    Set-Content -Path $outputFile -Value $body -Encoding utf8 -NoNewline
}

exit 0
