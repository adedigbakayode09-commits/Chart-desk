@echo off
rem ChartDesk: installs packages on first run, starts the server if it isn't running, opens the app.
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is not installed - get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
netstat -ano | findstr /r ":5178 .*LISTENING" >nul || start "ChartDesk server" /min cmd /c "node server\index.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:5178
