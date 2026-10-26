@echo off
chcp 65001 >nul
title Absolute Solver - 录音台
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0record-console.ps1" %*
echo.
echo 录音台已退出。
pause
