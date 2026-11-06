@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20.6+ first.
  pause
  exit /b 1
)
node src\server.mjs
if errorlevel 1 pause
