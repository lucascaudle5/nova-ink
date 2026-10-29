@echo off
setlocal
cd /d "%~dp0"
echo === NOVA Ink v0.2.3 reliability test (pending iPad acceptance) ===
if not exist node_modules (
  echo Installing project dependencies...
  call npm install || exit /b 1
)
echo Building tldraw for local development evaluation...
call npm run build:host-test || exit /b 1
echo Launching local-only MCP server...
call npm run start
