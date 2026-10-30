@echo off
setlocal
cd /d "%~dp0.."
echo Absolute Solver - Stage 2 access rehearsal
echo Uses local mock services only. It does not connect to production Hub, TTS, or the server.
echo.
node tools\access-acceptance-rehearsal.mjs
set "code=%ERRORLEVEL%"
echo.
if not "%code%"=="0" (
  echo Rehearsal failed with exit code %code%.
) else (
  echo Rehearsal passed. Real two-host acceptance still needs a local Allow click on the target host.
)
exit /b %code%
