@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "XYL_NODE="
where node >nul 2>nul
if not errorlevel 1 set "XYL_NODE=node"
if not defined XYL_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "XYL_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined XYL_NODE (
  echo 找不到 Node.js。请安装 Node.js 22 或 24 LTS，建议 24 LTS。
  pause
  exit /b 1
)
"%XYL_NODE%" "%~dp0server.mjs"
pause
