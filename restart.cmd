@echo off
rem 强制重启：结束班底自己的服务再起一个。
rem 注意：**会打断正在跑的 agent 任务**（被打断的运行会被标记为失败）。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 node。请先装 Node.js，或者把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)

node start.mjs --restart %*
set CODE=%errorlevel%
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%
