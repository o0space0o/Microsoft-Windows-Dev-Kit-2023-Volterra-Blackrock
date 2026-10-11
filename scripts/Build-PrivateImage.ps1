#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$BuildDirectory, [Parameter(Mandatory = $true)][string]$BaseBuildDirectory)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = [IO.Path]::GetFullPath($BuildDirectory)
$base = [IO.Path]::GetFullPath($BaseBuildDirectory)
$prefix = Join-Path $workspace 'build\'
if (-not $build.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not $base.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Both build paths must stay inside this workspace.' }
if (Test-Path -LiteralPath $build) { throw 'Existing builds will not be overwritten.' }
New-Item -ItemType Directory -Path $build | Out-Null
$dism = 'D:\GenImage\Tools\DISM\ARM64\dism.exe'
$logs = Join-Path $build 'logs'
New-Item -ItemType Directory -Path $logs | Out-Null
$scratch = Join-Path $build 'scratch'
New-Item -ItemType Directory -Path $scratch | Out-Null
function Status([string]$Phase, [string]$ErrorText = '') {
    @{ phase = $Phase; error = $ErrorText; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $build 'status.json') -Encoding utf8
}
function Invoke-Dism([string]$Name, [string[]]$Arguments) {
    & $dism /English @Arguments "/ScratchDir:$scratch" "/LogPath:$logs\$Name.log" /LogLevel:3 > (Join-Path $logs "$Name-output.txt")
    if ($LASTEXITCODE -notin @(0,3010)) { throw "DISM $Name failed ($LASTEXITCODE). See $logs\$Name-output.txt." }
}
function Invoke-Reg([string[]]$Arguments) {
    $result = & "$env:SystemRoot\System32\reg.exe" @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Offline registry operation failed ($LASTEXITCODE)." }
    $result | Add-Content -LiteralPath (Join-Path $logs 'registry.txt')
}
try {
    $packageNeutral = Join-Path $base 'boot\pkgs\neutral'
    $packageLanguage = Join-Path $base 'boot\pkgs\en-us'
    $drivers = Join-Path $base 'drivers'
    if (-not (Test-Path -LiteralPath $packageNeutral) -or -not (Test-Path -LiteralPath $drivers)) { throw 'The prepared package and exported driver directories are missing.' }
    foreach ($kind in @('boot','install')) {
        $index = if ($kind -eq 'boot') { 2 } else { 1 }
        $applied = Join-Path $build ("applied-$kind")
        New-Item -ItemType Directory -Path $applied | Out-Null
        Status "Applying original $kind image into ordinary files to avoid the failed hive mount"
        Invoke-Dism "apply-$kind" @('/Apply-Image','/ImageFile:D:\ValidationOS.wim',"/Index:$index","/ApplyDir:$applied",'/CheckIntegrity')
        $softwareKey = 'HKLM\VOLTERRA_SOFTWARE_' + [Guid]::NewGuid().ToString('N')
        Invoke-Reg @('load', $softwareKey, "$applied\Windows\System32\config\SOFTWARE")
        try { Invoke-Reg @('query', "$softwareKey\Microsoft\Windows NT\CurrentVersion", '/v', 'CurrentBuildNumber') }
        finally { Invoke-Reg @('unload', $softwareKey) }
        Status "Adding runtime packages to the $kind image"
        Invoke-Dism "packages-$kind" @("/Image:$applied",'/Add-Package',"/PackagePath:$packageNeutral","/PackagePath:$packageLanguage")
        Status "Adding exported signed device drivers to the $kind image"
        Invoke-Dism "drivers-$kind" @("/Image:$applied",'/Add-Driver',"/Driver:$drivers",'/Recurse')
        Status "Copying the application into the $kind image without account credentials"
        $payload = Join-Path $applied 'Volterra'
        New-Item -ItemType Directory -Path $payload | Out-Null
        foreach ($item in @('app','design\approved-v1','private\tools')) {
            $target = Join-Path $payload $item
            New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $workspace $item) -Destination $target -Recurse
        }
        $scripts = Join-Path $payload 'scripts'
        New-Item -ItemType Directory -Path $scripts | Out-Null
        foreach ($file in @('Start-Volterra.ps1','Open-Browser.ps1','Choose-Folder.ps1','Protect-Credential.ps1','Get-RestartStatus.ps1')) {
            Copy-Item -LiteralPath (Join-Path $workspace "scripts\$file") -Destination $scripts
        }
        foreach ($file in @('PROJECT_BRIEF.md','AGENTS.md','package.json','.gitignore')) { Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $payload }
        Copy-Item -LiteralPath 'D:\license.rtf' -Destination (Join-Path $payload 'Microsoft-Validation-OS-license.rtf')
        Copy-Item -LiteralPath (Join-Path $workspace 'image\Volterra-Startup.cmd') -Destination (Join-Path $applied 'Windows\Volterra-Startup.cmd')
        Invoke-Reg @('load', $softwareKey, "$applied\Windows\System32\config\SOFTWARE")
        try { Invoke-Reg @('add', "$softwareKey\Microsoft\Windows NT\CurrentVersion\Winlogon", '/v', 'Shell', '/t', 'REG_EXPAND_SZ', '/d', 'cmd.exe /k %windir%\Volterra-Startup.cmd', '/f') }
        finally { Invoke-Reg @('unload', $softwareKey) }
        if ($kind -eq 'boot') {
            $systemKey = 'HKLM\VOLTERRA_SYSTEM_' + [Guid]::NewGuid().ToString('N')
            Invoke-Reg @('load', $systemKey, "$applied\Windows\System32\config\SYSTEM")
            try {
                Invoke-Reg @('add', "$systemKey\ControlSet001\Control", '/v', 'SystemBootDriveLetter', '/t', 'REG_DWORD', '/d', '88', '/f')
                Invoke-Reg @('add', "$systemKey\ControlSet001\Services\XtaCache", '/v', 'Start', '/t', 'REG_DWORD', '/d', '4', '/f')
            } finally { Invoke-Reg @('unload', $systemKey) }
        }
        Invoke-Dism "inventory-$kind" @("/Image:$applied",'/Get-Drivers','/All')
        Status "Capturing the composed $kind image"
        $image = Join-Path $build "$kind.wim"
        $arguments = @('/Capture-Image',"/CaptureDir:$applied","/ImageFile:$image","/Name:Microsoft Volterra $kind",'/Compress:max','/CheckIntegrity','/Verify')
        if ($kind -eq 'boot') { $arguments += '/Bootable' }
        Invoke-Dism "capture-$kind" $arguments
    }
    Status 'Composed images captured; ISO and VM verification pending'
} catch { Status 'Failed' $_.Exception.Message; exit 1 }
