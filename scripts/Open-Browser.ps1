[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# The Node entry point validates the URL and the selected private profile before
# launching the staged system browser. There is no unguarded shell fallback.
& (Join-Path $taskRoot 'private\tools\node.exe') (Join-Path $taskRoot 'scripts\Open-Browser.mjs') $Url
exit $LASTEXITCODE