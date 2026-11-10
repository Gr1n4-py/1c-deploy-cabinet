@echo off
rem 1C Deploy Cabinet: backend (API + static) on http://127.0.0.1:8180/
rem No installs needed: portable folder = PowerShell 5.1 (built into Windows).
title 1C Deploy Cabinet - backend (port 8180)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "backend\server.ps1"
echo.
echo Backend stopped. Press any key to close this window.
pause >nul
