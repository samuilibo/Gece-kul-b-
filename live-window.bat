@echo off
rem Alternative to the OBS Browser Source: a dedicated Chromium/Edge window with full GPU acceleration.
rem Capture it in OBS with "Window Capture" (Windows 10 1903+ capture method) and "Application Audio Capture".
setlocal
cd /d "%~dp0"
set PORT=3000
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set PORT=%%b
set URL=http://localhost:%PORT%/live
if /i "%1"=="portrait" set URL=%URL%?layout=portrait
set W=1920& set H=1080
if /i "%1"=="portrait" (set W=1080& set H=1920)
set PROFILE=%~dp0data\live-window-profile
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
set BROWSER=%EDGE%
if exist "%CHROME%" set BROWSER=%CHROME%
start "" "%BROWSER%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=%W%,%H% --window-position=0,0 ^
  --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding ^
  --disable-backgrounding-occluded-windows --ignore-gpu-blocklist --force-device-scale-factor=1 --no-first-run
