@echo off
setlocal EnableExtensions

for %%I in ("%~dp0..") do set "REPO=%%~fI"
set "PREFLIGHT=%REPO%\scripts\graphify-git-preflight.mjs"
set "GRAPH=%REPO%\graphify-out\graph.json"
set "STATE=%REPO%\graphify-out\.graphify-state.json"
set "GRAPHIFY_QUERY_LOG_DISABLE=1"

if "%~1"=="" goto :usage
set "ACTION=%~1"

call :find_graphify
if errorlevel 1 exit /b %errorlevel%

node "%PREFLIGHT%" --repo "%REPO%" --graph "%GRAPH%" --state "%STATE%"
set "PREFLIGHT_CODE=%ERRORLEVEL%"
if %PREFLIGHT_CODE% GEQ 20 exit /b %PREFLIGHT_CODE%

set "NEED_REFRESH=0"
if %PREFLIGHT_CODE% EQU 10 set "NEED_REFRESH=1"

if /I "%ACTION%"=="build" goto :rebuild
if /I "%ACTION%"=="update" goto :rebuild

if /I "%ACTION%"=="query" (
  if "%~2"=="" goto :usage
  if "%NEED_REFRESH%"=="1" call :rebuild_or_fail
  if errorlevel 1 exit /b 1
  call :graphify query "%~2" --graph "%GRAPH%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

if /I "%ACTION%"=="path" (
  if "%~2"=="" goto :usage
  if "%~3"=="" goto :usage
  if "%NEED_REFRESH%"=="1" call :rebuild_or_fail
  if errorlevel 1 exit /b 1
  call :graphify path "%~2" "%~3" --graph "%GRAPH%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

if /I "%ACTION%"=="explain" (
  if "%~2"=="" goto :usage
  if "%NEED_REFRESH%"=="1" call :rebuild_or_fail
  if errorlevel 1 exit /b 1
  call :graphify explain "%~2" --graph "%GRAPH%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

if /I "%ACTION%"=="god-nodes" (
  if "%NEED_REFRESH%"=="1" call :rebuild_or_fail
  if errorlevel 1 exit /b 1
  call :graphify god-nodes --graph "%GRAPH%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

echo Unknown Graphify action: %ACTION%
goto :usage

:rebuild
call :rebuild_or_fail
if errorlevel 1 exit /b 1
exit /b 0

:rebuild_or_fail
pushd "%REPO%"
call :graphify extract "%REPO%" --code-only --force
set "GRAPHIFY_CODE=%ERRORLEVEL%"
popd
if not "%GRAPHIFY_CODE%"=="0" (
  echo Graphify code-only extraction failed with exit code %GRAPHIFY_CODE%.
  exit /b %GRAPHIFY_CODE%
)

node "%PREFLIGHT%" --repo "%REPO%" --graph "%GRAPH%" --state "%STATE%" --mark-fresh
if errorlevel 1 exit /b %errorlevel%
exit /b 0

:find_graphify
set "GRAPHIFY_MODE="
set "GRAPHIFY_BIN="
if exist "%REPO%\.tools\graphify\Scripts\python.exe" (
  set "GRAPHIFY_MODE=python"
  set "GRAPHIFY_BIN=%REPO%\.tools\graphify\Scripts\python.exe"
  exit /b 0
)

where graphify >nul 2>nul
if not errorlevel 1 (
  set "GRAPHIFY_MODE=cli"
  set "GRAPHIFY_BIN=graphify"
  exit /b 0
)

echo Graphify is not installed locally.
echo Recommended DC2 install:
echo   py -3.12 -m venv "%REPO%\.tools\graphify"
echo   "%REPO%\.tools\graphify\Scripts\python.exe" -m pip install graphifyy==0.9.53
exit /b 22

:graphify
if "%GRAPHIFY_MODE%"=="python" (
  "%GRAPHIFY_BIN%" -m graphify %*
  if errorlevel 1 exit /b 1
  exit /b 0
)
"%GRAPHIFY_BIN%" %*
if errorlevel 1 exit /b 1
exit /b 0

:usage
echo Usage:
echo   scripts\graphify-local.cmd build
echo   scripts\graphify-local.cmd update
echo   scripts\graphify-local.cmd query "question"
echo   scripts\graphify-local.cmd path "Node A" "Node B"
echo   scripts\graphify-local.cmd explain "Node"
echo   scripts\graphify-local.cmd god-nodes
exit /b 2
