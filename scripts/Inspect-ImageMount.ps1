#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = [IO.Path]::GetFullPath($BuildDirectory)
if (-not $build.StartsWith((Join-Path $workspace 'build\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected build directory.' }
$report = Join-Path $build 'mount-inspection'
New-Item -ItemType Directory -Path $report -Force | Out-Null
try {
    Get-WindowsImage -Mounted | Select-Object Path, ImagePath, ImageIndex, MountStatus |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $report 'mounted-images.json') -Encoding utf8
    $mount = Join-Path $build 'boot\mount'
    Get-Item -LiteralPath "$mount\Windows\System32\config\SYSTEM", "$mount\Windows\System32\config\SOFTWARE" -Force |
        Select-Object FullName, Length, Attributes | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $report 'hives.json') -Encoding utf8
    $key = 'HKLM\VOLTERRA_PROBE_' + [Guid]::NewGuid().ToString('N')
    & reg.exe load $key "$mount\Windows\System32\config\SOFTWARE" > (Join-Path $report 'hive-load.txt')
    if ($LASTEXITCODE -ne 0) { throw "Offline SOFTWARE hive could not be loaded ($LASTEXITCODE)." }
    try { & reg.exe query "$key\Microsoft\Windows NT\CurrentVersion" > (Join-Path $report 'offline-version.txt') }
    finally { & reg.exe unload $key > (Join-Path $report 'hive-unload.txt') }
    $dism = 'D:\GenImage\Tools\DISM\ARM64\dism.exe'
    & $dism /English "/Image:$mount" /Get-Packages "/LogPath:$report\packages.log" > (Join-Path $report 'packages.txt')
    @{ status = 'complete'; packagesExitCode = $LASTEXITCODE } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json')
} catch { @{ status = 'failed'; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json') }
