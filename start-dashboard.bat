@echo off
rem Codex Remote Contact - service dashboard launcher.
rem Starts the hub hidden if it is not already listening on 3789,
rem then opens the dashboard in the default browser.
setlocal
set "HUB_DIR=%~dp0"
set "HUB_LOG=%~dp0runtime\hub-console.log"
if not exist "%HUB_DIR%runtime" mkdir "%HUB_DIR%runtime"
set "CRC_TOKEN="
if exist "%HUB_DIR%data\access-token.txt" set /p CRC_TOKEN=<"%HUB_DIR%data\access-token.txt"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort 3789 -State Listen -ErrorAction SilentlyContinue; " ^
  "if (-not $c) { " ^
  "  $env:ONEBOT_WS_URL = 'ws://127.0.0.1:3002'; " ^
  "  $env:CODEX_REMOTE_CONTACT_HOST = '0.0.0.0'; " ^
  "  $env:CODEX_REMOTE_CONTACT_ACCESS_TOKEN = '%CRC_TOKEN%'; " ^
  "  Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'src/server.js' " ^
  "    -WorkingDirectory '%HUB_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%HUB_LOG%' -RedirectStandardError '%HUB_LOG%.err' " ^
  "}"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3789"
endlocal
