@echo off
rem bandi - the one command for this checkout. ASCII only + CRLF (cmd parses .cmd with the
rem system ANSI code page; UTF-8 comments here have silently eaten lines before).
rem Installed builds get their own shim from: bandi install-cli --path
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Install Node.js 22+ or add it to PATH.
  echo.
  pause
  exit /b 1
)
node "%~dp0apps\server\src\cli.mjs" %*
