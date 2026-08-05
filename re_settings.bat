@echo off
setlocal
cd /d "%~dp0"

set "DEPLOY_ARGS="
set "NO_PAUSE=0"
set "NO_VERSION_BUMP=0"
set "CHECK_ONLY=0"

:parse_args
if "%~1"=="" goto run_deploy
if /I "%~1"=="--no-bump" set "NO_VERSION_BUMP=1"
if /I "%~1"=="--check" set "CHECK_ONLY=1"
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
shift
goto parse_args

:run_deploy
if "%NO_VERSION_BUMP%"=="1" set "DEPLOY_ARGS=%DEPLOY_ARGS% -NoVersionBump"
if "%CHECK_ONLY%"=="1" set "DEPLOY_ARGS=%DEPLOY_ARGS% -CheckOnly -NoVersionBump"
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
if "%CHECK_ONLY%"=="1" echo Deployment preflight completed. Nothing was deployed or changed.
if "%CHECK_ONLY%"=="1" goto finish_success
echo Deployment and secret setup completed.
:finish_success
if "%NO_PAUSE%"=="1" exit /b 0
pause
exit /b 0
