@echo off
rem 双击我就能启动班底平台。
rem 真正的逻辑在 start.mjs 里（要判断端口被谁占、是不是我们自己的服务）。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   找不到 node。请先装 Node.js，或者把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)

node start.mjs %*
set CODE=%errorlevel%

rem 出错时别让窗口一闪而过，留给人看
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%
