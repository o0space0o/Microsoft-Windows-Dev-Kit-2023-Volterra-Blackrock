#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = [IO.Path]::GetFullPath($BuildDirectory)
if (-not $build.StartsWith((Join-Path $workspace 'build\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected probe directory.' }
$hive = Join-Path $build 'applied-boot\Windows\System32\config\SOFTWARE'
$report = Join-Path $build 'hive-probe'
New-Item -ItemType Directory -Path $report -Force | Out-Null
$key = 'HKLM\VOLTERRA_PROBE_' + [Guid]::NewGuid().ToString('N')
$arguments = 'load "{0}" "{1}"' -f $key, $hive
$process = Start-Process -FilePath "$env:SystemRoot\System32\reg.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $report 'stdout.txt') -RedirectStandardError (Join-Path $report 'stderr.txt')
$process.WaitForExit()
if ($process.ExitCode -eq 0) {
    & "$env:SystemRoot\System32\reg.exe" query "$key\Microsoft\Windows NT\CurrentVersion" /v CurrentBuildNumber > (Join-Path $report 'version.txt')
    & "$env:SystemRoot\System32\reg.exe" unload $key > (Join-Path $report 'unload.txt')
}
& 'D:\GenImage\Tools\DISM\ARM64\dism.exe' /English /Get-WimInfo /WimFile:D:\ValidationOS.wim /Index:2 > (Join-Path $report 'original-image-info.txt')
$stream = [IO.File]::OpenRead($hive)
try { $header = New-Object byte[] 32; [void]$stream.Read($header,0,32); [BitConverter]::ToString($header) | Set-Content -LiteralPath (Join-Path $report 'hive-header.txt') }
finally { $stream.Dispose() }
@{ status = 'complete'; hiveLoadExitCode = $process.ExitCode } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json')
