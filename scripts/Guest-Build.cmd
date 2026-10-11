@echo off
setlocal EnableExtensions
set "DATA=%~1"
set "DISM=%DATA%\Tools\dism.exe"
set "LOGS=%DATA%\Output"
set "SCRATCH=%DATA%\Scratch"
mkdir "%SCRATCH%"
mkdir "%DATA%\Work"
echo Verifying offline hive access inside Windows PE>"%LOGS%\progress.txt"
call :Build boot 2 X 88
if errorlevel 1 goto failed
call :Build install 1 C 67
if errorlevel 1 goto failed
echo {"status":"passed","build":"development-006","physicalTested":false}>"%LOGS%\result.json"
exit /b 0
:failed
echo {"status":"failed","build":"development-006","physicalTested":false}>"%LOGS%\result.json"
exit /b 1

:Build
set "KIND=%~1"
set "INDEX=%~2"
set "LETTER=%~3"
set "LETTERCODE=%~4"
set "MOUNT=%DATA%\Work\%KIND%-mount"
set "WIM=%DATA%\Work\%KIND%.wim"
set "BOOTFLAG="
if "%KIND%"=="boot" set "BOOTFLAG=/Bootable"
echo Exporting %KIND% image>"%LOGS%\progress.txt"
echo Exporting %KIND% image>CON
"%DISM%" /English /Export-Image /SourceImageFile:"%DATA%\ValidationOS.wim" /SourceIndex:%INDEX% /DestinationImageFile:"%WIM%" /Compress:max /CheckIntegrity %BOOTFLAG% /LogPath:"%LOGS%\export-%KIND%.log"
if errorlevel 1 exit /b 1
mkdir "%MOUNT%"
"%DISM%" /English /Mount-Image /ImageFile:"%WIM%" /Index:1 /MountDir:"%MOUNT%" /ScratchDir:"%SCRATCH%" /LogPath:"%LOGS%\mount-%KIND%.log"
if errorlevel 1 exit /b 1
reg load HKLM\VTSOFT "%MOUNT%\Windows\System32\config\SOFTWARE"
if errorlevel 1 exit /b 1
reg query "HKLM\VTSOFT\Microsoft\Windows NT\CurrentVersion" /v EditionID
reg unload HKLM\VTSOFT
if errorlevel 1 exit /b 1
echo Adding %KIND% runtime packages>"%LOGS%\progress.txt"
echo Adding %KIND% runtime packages>CON
"%DISM%" /English /Image:"%MOUNT%" /Add-Package /PackagePath:"%DATA%\Cabs\neutral" /PackagePath:"%DATA%\Cabs\en-us" /ScratchDir:"%SCRATCH%" /LogPath:"%LOGS%\packages-%KIND%.log"
if errorlevel 3011 exit /b 1
if errorlevel 1 if not errorlevel 3010 exit /b 1
echo Adding %KIND% signed device drivers>"%LOGS%\progress.txt"
echo Adding %KIND% signed device drivers>CON
"%DISM%" /English /Image:"%MOUNT%" /Add-Driver /Driver:"%DATA%\Drivers" /Recurse /ScratchDir:"%SCRATCH%" /LogPath:"%LOGS%\drivers-%KIND%.log"
if errorlevel 3011 exit /b 1
if errorlevel 1 if not errorlevel 3010 exit /b 1
echo Copying %KIND% helper without credentials>"%LOGS%\progress.txt"
echo Copying %KIND% helper without credentials>CON
robocopy "%DATA%\Payload" "%MOUNT%\Volterra" /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ /NP
if errorlevel 8 exit /b 1
copy /y "%DATA%\Volterra-Startup.cmd" "%MOUNT%\Windows\Volterra-Startup.cmd"
if errorlevel 1 exit /b 1
copy /y "%DATA%\Payload\PROJECT_BRIEF.md" "%MOUNT%\PROJECT_BRIEF.md"
copy /y "%DATA%\Payload\AGENTS.md" "%MOUNT%\AGENTS.md"
reg load HKLM\VTSOFT "%MOUNT%\Windows\System32\config\SOFTWARE"
if errorlevel 1 exit /b 1
reg add "HKLM\VTSOFT\Microsoft\Windows NT\CurrentVersion\Winlogon" /v Shell /t REG_SZ /d "cmd.exe /k %LETTER%:\Windows\Volterra-Startup.cmd" /f
if errorlevel 1 exit /b 1
reg unload HKLM\VTSOFT
if errorlevel 1 exit /b 1
reg load HKLM\VTSYSTEM "%MOUNT%\Windows\System32\config\SYSTEM"
if errorlevel 1 exit /b 1
reg add HKLM\VTSYSTEM\ControlSet001\Control /v SystemBootDriveLetter /t REG_DWORD /d %LETTERCODE% /f
if errorlevel 1 exit /b 1
if "%KIND%"=="boot" reg add HKLM\VTSYSTEM\ControlSet001\Services\XtaCache /v Start /t REG_DWORD /d 4 /f
reg unload HKLM\VTSYSTEM
if errorlevel 1 exit /b 1
"%DISM%" /English /Image:"%MOUNT%" /Get-Drivers /All >"%LOGS%\inventory-%KIND%.txt"
"%DISM%" /English /Image:"%MOUNT%" /Get-Packages >"%LOGS%\package-inventory-%KIND%.txt"
echo Committing %KIND% image>"%LOGS%\progress.txt"
echo Committing %KIND% image>CON
"%DISM%" /English /Unmount-Image /MountDir:"%MOUNT%" /Commit /CheckIntegrity /ScratchDir:"%SCRATCH%" /LogPath:"%LOGS%\commit-%KIND%.log"
if errorlevel 1 exit /b 1
echo Sealing %KIND% image>"%LOGS%\progress.txt"
echo Sealing %KIND% image>CON
"%DISM%" /English /Export-Image /SourceImageFile:"%WIM%" /SourceIndex:1 /DestinationImageFile:"%LOGS%\%KIND%.wim" /Compress:max /CheckIntegrity %BOOTFLAG% /LogPath:"%LOGS%\seal-%KIND%.log"
if errorlevel 1 exit /b 1
exit /b 0
