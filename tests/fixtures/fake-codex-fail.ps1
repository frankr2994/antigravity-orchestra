#requires -Version 5.1
# Test fixture: simulates a codex CLI failure (non-zero exit, stderr output).

$input | Out-Null
[Console]::Error.WriteLine('simulated codex failure')
exit 1
