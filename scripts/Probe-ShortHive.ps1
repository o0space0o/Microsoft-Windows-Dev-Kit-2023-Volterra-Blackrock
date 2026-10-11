#Requires -RunAsAdministrator
param([Parameter(Mandatory = $true)][string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = [IO.Path]::GetFullPath($BuildDirectory)
if (-not $build.StartsWith((Join-Path $workspace 'build\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected probe directory.' }
$report = Join-Path $build 'short-hive-probe'
New-Item -ItemType Directory -Path $report -Force | Out-Null
$short = 'C:\VH-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
New-Item -ItemType Directory -Path $short | Out-Null
Copy-Item -LiteralPath (Join-Path $build 'applied-boot\Windows\System32\config\SOFTWARE') -Destination (Join-Path $short 'SOFTWARE')
$key = 'HKLM\VT' + [Guid]::NewGuid().ToString('N').Substring(0,6)
$process = Start-Process -FilePath "$env:SystemRoot\System32\reg.exe" -ArgumentList ('load "{0}" "{1}\SOFTWARE"' -f $key,$short) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $report 'stdout.txt') -RedirectStandardError (Join-Path $report 'stderr.txt')
$process.WaitForExit(); $process.Refresh()
if (Test-Path -LiteralPath ($key -replace '^HKLM\\','HKLM:\')) {
    & reg.exe query "$key\Microsoft\Windows NT\CurrentVersion" /v CurrentBuildNumber > (Join-Path $report 'version.txt')
    & reg.exe unload $key > (Join-Path $report 'unload.txt')
}
@{ status = 'complete'; shortPath = $short; exitCode = $process.ExitCode } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json')
