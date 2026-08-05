@echo off
setlocal
cd /d "%~dp0"

set "DEPLOY_ARGS="
set "NO_PAUSE=0"

:parse_args
if "%~1"=="" goto run_deploy
if /I "%~1"=="--no-bump" set "DEPLOY_ARGS=-NoVersionBump"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
shift
goto parse_args

:run_deploy
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-setup.ps1" %DEPLOY_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" goto success
echo.
echo Deployment setup failed. Check the error above.
if "%NO_PAUSE%"=="1" exit /b %EXIT_CODE%
pause
exit /b %EXIT_CODE%

:success
echo.
echo Deployment and secret setup completed.
if "%NO_PAUSE%"=="1" exit /b 0
pause
exit /b 0
