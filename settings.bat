@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-wizard.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" goto success
echo.
echo Initial setup stopped or failed. Check the message above.
pause
exit /b %EXIT_CODE%

:success
echo.
echo Initial setup wizard finished.
pause
exit /b 0
