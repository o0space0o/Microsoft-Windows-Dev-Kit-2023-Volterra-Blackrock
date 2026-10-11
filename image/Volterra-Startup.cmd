@echo off
title Microsoft Volterra development terminal
echo Microsoft Volterra - private ARM64 development image
echo.
echo This terminal shows helper output. Project files must live on persistent storage.
echo No account credentials are included in this image.
echo.
set "VOLTERRA_ROOT=%SystemDrive%\Volterra"
if not exist "%VOLTERRA_ROOT%\private\tools\node.exe" (
  echo The helper payload is missing. This build is incomplete.
  exit /b 1
)
powershell -NoProfile -File "%VOLTERRA_ROOT%\scripts\Start-Volterra.ps1" -Boot
echo.
echo The helper stopped. Review the output above before restarting it.
