@echo off
title Microsoft Volterra isolated image servicing
wpeinit
for %%D in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do (
  if exist "%%D:\Volterra-development-006.tag" (
    call "%%D:\Guest-Build.cmd" "%%D:" > "%%D:\Output\guest-console.txt" 2>&1
    wpeutil shutdown
    exit /b
  )
)
echo The owned development data disk was not found.
cmd /k
