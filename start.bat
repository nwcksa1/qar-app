@echo off
REM ===========================================================================
REM  NWC QAR - Windows launcher
REM  Runs the automated test checks first. Production starts ONLY if all pass.
REM  Colleagues on the office LAN use the printed http://<your-ip>:3000 address
REM  (run allow-firewall-port-3000.bat once).
REM ===========================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title NWC QAR Server
if "%PORT%"=="" set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Download Node.js 18 LTS or later from https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo [ERROR] Node.js 18 or later is required.
  node -v
  pause
  exit /b 1
)

echo.
echo  ==============================================================
echo    NWC Quality Assurance Review (QAR)
echo  ==============================================================
echo    This PC       : http://localhost:%PORT%/login.html
echo    Admin portal  : http://localhost:%PORT%/admin/login.html
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4"') do (
  set "IP=%%a"
  set "IP=!IP: =!"
  echo    Office LAN    : http://!IP!:%PORT%/login.html
)
echo  ==============================================================
echo    Test checks run first; production starts only if all pass.
echo    Keep this window open. Press Ctrl+C to stop the server.
echo.
node launch.js
if errorlevel 1 (
  echo.
  echo [BLOCKED] Production was not started or stopped with an error.
  echo           See logs\last-test-report.json for details.
)
echo.
pause
