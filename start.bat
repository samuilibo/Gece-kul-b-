@echo off
rem NEON CLUB LIVE - start server (and optionally open the admin panel)
setlocal
cd /d "%~dp0"
if not exist node_modules call setup.bat
if not exist dist\live.html call npm run build
set PORT=3000
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set PORT=%%b
start "" http://localhost:%PORT%/admin
echo Live view for OBS: http://localhost:%PORT%/live
call npm start
pause
