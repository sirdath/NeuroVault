@echo off
REM NeuroVault launcher (visible console fallback).
REM
REM Plain .bat that shows build output — useful when the .vbs silent
REM launcher hides a failure you need to diagnose. Double-click as a
REM troubleshooting aid.

cd /d "D:\Ai-Brain\engram"
echo [NeuroVault] starting Tauri dev shell...
npx tauri dev
pause
