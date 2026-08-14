#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$dashboard = Join-Path $PSScriptRoot 'orchestra-dashboard'
if (!(Test-Path (Join-Path $dashboard 'node_modules'))) {
    Write-Host 'Installing dashboard dependencies...' -ForegroundColor Cyan
    & npm.cmd install --prefix $dashboard
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}
Write-Host 'Starting Antigravity Orchestra...' -ForegroundColor Cyan
& npm.cmd run dev --prefix $dashboard
exit $LASTEXITCODE
