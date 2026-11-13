@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-test.ps1"
if errorlevel 1 echo ERROR: Test server did not start. See the message above.
pause
