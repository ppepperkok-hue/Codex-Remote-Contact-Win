@echo off
rem Codex Remote Contact - service dashboard launcher.
rem Starts the hub hidden if it is not already listening on 3789,
rem then opens the dashboard in the default browser.
rem Machine specific values live in data/hub.env (see hub.env.example).
setlocal
set "HUB_DIR=%~dp0"
set "HUB_LOG=%~dp0runtime\hub-console.log"
if not exist "%HUB_DIR%runtime" mkdir "%HUB_DIR%runtime"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort 3789 -State Listen -ErrorAction SilentlyContinue; " ^
  "if (-not $c) { " ^
  "  $node = (Get-Command node -ErrorAction SilentlyContinue).Source; " ^
  "  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' } " ^
  "  Start-Process -FilePath $node -ArgumentList 'src/load-env.js' " ^
  "    -WorkingDirectory '%HUB_DIR%' -WindowStyle Hidden -RedirectStandardOutput '%HUB_LOG%' -RedirectStandardError '%HUB_LOG%.err' " ^
  "}"

timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:3789"
endlocal
