@echo off
rem Launch the desktop shell in DEV mode (reads apps\web and apps\server straight from this repo).
rem
rem Why BANDI_HOME is set here: after a `tauri build`, Tauri stages bundle.resources
rem (runtime/apps -> apps) into apps\desktop\target\release\apps\ . find_root() walks up from
rem the exe and stops at the first dir containing apps\desktop\shell.mjs -- which is that
rem staged copy, one level above the exe. Result: the shell silently runs a frozen snapshot
rem and nothing you edit in the repo applies. BANDI_HOME is checked first, so pinning it to
rem the repo root makes dev builds behave like dev builds again.
cd /d "%~dp0"
set "BANDI_HOME=%~dp0"

if not exist "apps\desktop\target\release\bandi-desktop.exe" (
  echo.
  echo   Shell exe not found: apps\desktop\target\release\bandi-desktop.exe
  echo   Build it once:  cd apps\desktop  ^&^&  npx @tauri-apps/cli@2 build
  echo.
  pause
  exit /b 1
)

echo Starting dev shell (BANDI_HOME=%BANDI_HOME%)
start "" "apps\desktop\target\release\bandi-desktop.exe"
exit /b 0
