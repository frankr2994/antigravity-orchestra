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

# 2. Build the request for LM Studio (OpenAI Compatible API)
$prompt = @"
You are a technical scribe. Here is a git diff of the latest changes:

$diff

Please provide a concise, high-level summary of these changes in bullet points. Do not include introductory text, just the bullet points.
"@

$body = @{
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
    $response = Invoke-RestMethod -Uri "http://localhost:1234/v1/chat/completions" -Method Post -Body $body -ContentType "application/json"
    $summary = $response.choices[0].message.content.Trim()
} catch {
    Write-Error "Failed to reach LM Studio. Please make sure the Local Inference Server is running on port 1234."
    exit 1
}

Write-Host "Summary generated. Updating HANDOFF.md..." -ForegroundColor Green

# 4. Append to HANDOFF.md
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$handoffEntry = @"

## [$timestamp] Handoff Update
$summary

"@

$handoffFile = "docs/HANDOFF.md"
if (!(Test-Path "docs")) { New-Item -ItemType Directory -Path "docs" | Out-Null }
Add-Content -Path $handoffFile -Value $handoffEntry

# 5. Commit to Git
Write-Host "Staging and Committing..." -ForegroundColor Cyan
git add .

# Create a short title for the commit message (first line of summary)
$firstLine = ($summary -split '\r?\n')[0] -replace '^[\-\*\s]+',''
$commitTitle = "Update: $firstLine"

git commit -m $commitTitle -m $summary | Out-Null

Write-Host "Success! Changes logged to $handoffFile and committed to git." -ForegroundColor Green
