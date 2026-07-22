@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-native-host.ps1"
if errorlevel 1 (
  echo.
  echo A instalacao nao foi concluida.
  pause
  exit /b 1
)
exit /b 0
