@echo off
REM ===========================================================================
REM  Opens inbound TCP 3000 in Windows Defender Firewall so office LAN
REM  colleagues can reach the QAR server. Requests admin rights automatically.
REM  Scope: Domain + Private networks only (never Public Wi-Fi).
REM ===========================================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set RULE=NWC QAR Web App (TCP 3000)
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=3000 profile=domain,private
if %errorlevel% equ 0 (
  echo.
  echo [OK] Firewall rule "%RULE%" created for Domain and Private networks.
  echo      To remove it later:  netsh advfirewall firewall delete rule name="%RULE%"
) else (
  echo [ERROR] Could not create the firewall rule.
)
echo.
pause
