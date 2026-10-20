@echo off
rem Starts the ChartDesk server automatically whenever you sign in to Windows (no window). Undo: uninstall-autostart.bat
cd /d "%~dp0"
if not exist node_modules call npm install
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\ChartDesk.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0start-hidden.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo ChartDesk will now start when you sign in. Open http://127.0.0.1:5178
