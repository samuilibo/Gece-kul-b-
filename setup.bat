@echo off
rem NEON CLUB LIVE - first-time setup for Windows 11
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 LTS ^(22.13 or newer^) from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (set MAJ=%%a& set MIN=%%b)
if %MAJ% LSS 22 (
  echo Node.js 22.13+ is required ^(found %MAJ%.%MIN%^).
  pause
  exit /b 1
)
echo Installing dependencies...
call npm ci || call npm install || goto :fail
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - edit it to add your YouTube API key.
)
if not exist music mkdir music
echo Building...
call npm run build || goto :fail
echo.
echo Setup finished. Start the club with start.bat
pause
exit /b 0
:fail
echo Setup failed - see the messages above.
pause
exit /b 1
