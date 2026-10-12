[CmdletBinding()]
param([switch]$Boot, [switch]$NoBrowser, [int]$Port = 43123)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = Join-Path $taskRoot 'private\tools\node.exe'
$launcher = Join-Path $taskRoot 'scripts\Start-Volterra.mjs'
# Both entry points share the source-bound native private-storage prerequisite.
# This wrapper has no separate State writer, browser or runtime launch path.
$arguments = @($launcher, '--port', [string]$Port)
if ($Boot) { $arguments += '--boot' }
if ($NoBrowser) { $arguments += '--no-browser' }
& $node @arguments
exit $LASTEXITCODE