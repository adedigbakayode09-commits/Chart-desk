' Starts the ChartDesk server with no window (used by install-autostart.bat at Windows sign-in).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node server\index.js", 0, False
