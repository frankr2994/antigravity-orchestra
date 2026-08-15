$ErrorActionPreference = 'Stop'
$rootDir = $PSScriptRoot | Split-Path -Parent
$staging = Join-Path $env:TEMP "orchestra-v1.0.0-staging"

if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Copy-Item -Path (Join-Path $rootDir "Start-Orchestra.ps1"), (Join-Path $rootDir "Start-Orchestra.bat"), (Join-Path $rootDir "README.md"), (Join-Path $rootDir "LICENSE") -Destination $staging -Force
Copy-Item -Path (Join-Path $rootDir ".agents"), (Join-Path $rootDir ".codex"), (Join-Path $rootDir "docs") -Destination $staging -Recurse -Force

$dashboardStaging = Join-Path $staging "orchestra-dashboard"
New-Item -ItemType Directory -Path $dashboardStaging -Force | Out-Null
Copy-Item -Path (Join-Path $rootDir "orchestra-dashboard\package.json"), (Join-Path $rootDir "orchestra-dashboard\package-lock.json") -Destination $dashboardStaging -Force
Copy-Item -Path (Join-Path $rootDir "orchestra-dashboard\dist"), (Join-Path $rootDir "orchestra-dashboard\dist-server"), (Join-Path $rootDir "orchestra-dashboard\scripts") -Destination $dashboardStaging -Recurse -Force

$zipPath = Join-Path $rootDir "orchestra-v1.0.0-windows-x64.zip"
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -Force
Remove-Item -Recurse -Force $staging

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "Release package created successfully: $zipPath ($sizeMB MB)" -ForegroundColor Green
