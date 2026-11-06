@echo off
chcp 936 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo.
echo Disabling local autostart: TodoReminder / NapCatBot
echo (the cloud server is now the primary one; re-enable later if needed)
echo.
schtasks /Change /TN "TodoReminder" /DISABLE
schtasks /Change /TN "NapCatBot" /DISABLE
echo.
schtasks /Query /TN "TodoReminder" /FO LIST
echo.
schtasks /Query /TN "NapCatBot" /FO LIST
echo.
echo Done.
pause
