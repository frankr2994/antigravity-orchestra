@echo off
title Antigravity Orchestra Command Center
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Orchestra.ps1"
if %ERRORLEVEL% neq 0 (
    echo.
    echo Orchestra exited with code %ERRORLEVEL%.
    pause
)
