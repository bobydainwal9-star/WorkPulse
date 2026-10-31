@echo off
setlocal
cd /d "%~dp0"

 echo ==========================================
 echo   WorkPulse Smart Attendance - Startup
 echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js from https://nodejs.org/ and restart Windows Terminal.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found in PATH.
  echo Reinstall Node.js using the official installer, including npm.
  pause
  exit /b 1
)

REM Check for a required package, not just the existence of node_modules.
if not exist "node_modules\dotenv\package.json" (
  echo Installing required packages. Keep this window open...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 goto install_failed
)

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
  ) else (
    echo ERROR: .env.example is missing from this folder.
    pause
    exit /b 1
  )
)

call npm.cmd start
if errorlevel 1 (
  echo.
  echo WorkPulse stopped with an error. Read the message above.
  pause
  exit /b 1
)
pause
exit /b 0

:install_failed
echo.
echo ERROR: Package installation failed. WorkPulse was not started.
echo.
echo Try this:
echo 1. Close this window.
echo 2. Move this folder to C:\WorkPulse (create the folder if needed).
echo 3. Open Command Prompt in that folder.
echo 4. Run: npm.cmd install --no-audit --no-fund
echo 5. If it still fails, run: where npm  and  where node
echo 6. Check Windows Security or antivirus quarantine and folder permissions.
echo Do not delete random files from the Node.js installation.
pause
exit /b 1
