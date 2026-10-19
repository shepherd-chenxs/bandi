@echo off
rem Start bandi. Real logic lives in start.mjs (port checks etc.).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install Node.js or add it to PATH.
  echo.
  pause
  exit /b 1
)

node start.mjs %*
set CODE=%errorlevel%

rem Keep the window open on error so the message can be read.
if not "%CODE%"=="0" (
  echo.
  pause
)
exit /b %CODE%
