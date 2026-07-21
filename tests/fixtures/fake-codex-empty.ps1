#requires -Version 5.1
# Test fixture: simulates codex exiting 0 but producing no response
# (e.g. not logged in). Creates an empty output file.

$input | Out-Null

$outputIndex = [Array]::IndexOf($args, '--output-last-message')
if ($outputIndex -ge 0 -and $outputIndex + 1 -lt $args.Count) {
    $outputFile = $args[$outputIndex + 1]
    New-Item -ItemType File -Path $outputFile -Force | Out-Null
}

exit 0
