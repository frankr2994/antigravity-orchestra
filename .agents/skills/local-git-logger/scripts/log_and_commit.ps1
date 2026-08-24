param (
    [string]$ModelName = "local-model" # LM Studio typically uses whatever model is loaded
)

# 1. Get the diff
$diff = git diff
$isStaged = $false

if ([string]::IsNullOrWhiteSpace($diff)) {
    # If no unstaged changes, check for staged changes
    $diff = git diff --cached
    if ([string]::IsNullOrWhiteSpace($diff)) {
        Write-Output "No changes found to log."
        exit 0
    }
    $isStaged = $true
}

Write-Host "Found changes. Querying LM Studio..." -ForegroundColor Cyan

# Resolve the model actually loaded in LM Studio unless the caller selected one.
if ($ModelName -eq "local-model") {
    try {
        $inventory = Invoke-RestMethod -Uri "http://localhost:1234/api/v1/models" -Method Get -TimeoutSec 10
        $loaded = @($inventory.models | Where-Object { $_.type -eq "llm" -and @($_.loaded_instances).Count -gt 0 }) | Select-Object -First 1
        if ($null -eq $loaded) { throw "LM Studio has no loaded LLM instance." }
        $ModelName = [string]$loaded.loaded_instances[0].id
    } catch {
        Write-Error "LM Studio is reachable only when its Local Server is running with a loaded chat model. $($_.Exception.Message)"
        exit 1
    }
}

# Context is finite even though local inference has no metered quota. Preserve both
# ends of a large diff instead of sending a request the loaded model cannot accept.
$diffText = $diff | Out-String
$maxDiffCharacters = 24000
if ($diffText.Length -gt $maxDiffCharacters) {
    $half = [int](($maxDiffCharacters - 120) / 2)
    $diffText = $diffText.Substring(0, $half) + "`n... [bounded local summary input] ...`n" + $diffText.Substring($diffText.Length - $half)
}

# 2. Build the request for LM Studio (OpenAI Compatible API)
$prompt = @"
You are a technical scribe. Here is a git diff of the latest changes:

$diffText

Please provide a concise, high-level summary of these changes in bullet points. Do not include introductory text, just the bullet points.
"@

$body = @{
    model = $ModelName
    messages = @(
        @{ role = "system"; content = "You are a helpful programming assistant that writes git commit summaries." },
        @{ role = "user"; content = $prompt }
    )
    temperature = 0.3
    max_tokens = 300
} | ConvertTo-Json -Depth 10

# 3. Call LM Studio API
try {
    # LM Studio default server runs on localhost:1234
    $response = Invoke-RestMethod -Uri "http://localhost:1234/v1/chat/completions" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 60
    $summary = $response.choices[0].message.content.Trim()
} catch {
    $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Error "LM Studio summary request failed for model '$ModelName'. $detail"
    exit 1
}

Write-Host "Summary generated. Updating HANDOFF.md..." -ForegroundColor Green

# 4. Append to HANDOFF.md
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$handoffEntry = "`n`n## [$timestamp] Handoff Update`n$summary"

$handoffFile = "docs/HANDOFF.md"
if (!(Test-Path "docs")) { New-Item -ItemType Directory -Path "docs" | Out-Null }
Add-Content -Path $handoffFile -Value $handoffEntry

# 5. Commit to Git
Write-Host "Staging and Committing..." -ForegroundColor Cyan
# Only stage tracked updates plus the handoff file created by this script. New files
# must be selected explicitly before invoking the logger so unrelated untracked
# workspace files are never swept into an automated commit.
git add --update
git add -- $handoffFile

# Create a short title for the commit message (first line of summary)
$firstLine = ($summary -split '\r?\n')[0] -replace '^[\-\*\s]+',''
$commitTitle = "Update: $firstLine"

git commit -m $commitTitle -m $summary | Out-Null

Write-Host "Success! Changes logged to $handoffFile and committed to git." -ForegroundColor Green
