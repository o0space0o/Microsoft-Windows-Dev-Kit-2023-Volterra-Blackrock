[CmdletBinding()]
param([switch]$Boot, [switch]$NoBrowser, [int]$Port = 43123)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $taskRoot 'private\tools'
$node = Join-Path $tools 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
$codex = Join-Path $tools 'codex.exe'
if (Test-Path -LiteralPath $codex) { $env:VOLTERRA_CODEX_PATH = $codex }
else { $env:VOLTERRA_CODEX_PATH = (Get-Command codex -ErrorAction Stop).Source }
$gh = Join-Path $tools 'gh.exe'
if (Test-Path -LiteralPath $gh) { $env:VOLTERRA_GH_PATH = $gh }
$gitFolder = Join-Path $tools 'git\cmd'
if (Test-Path -LiteralPath $gitFolder) { $env:PATH = "$gitFolder;$tools;$env:PATH" }
$env:VOLTERRA_GIT_PATH = Join-Path $gitFolder 'git.exe'
if ($Boot) {
    $edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
    if ($edition -ne 'WinVOS') { throw 'OS root mode is restricted to the Validation OS image.' }
    $env:VOLTERRA_OS_ROOT = "$env:SystemDrive\"
    if ($env:SystemDrive -eq 'X:') {
        $storage = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -ne 'X' -and (Test-Path -LiteralPath (Join-Path $_.Root 'Volterra-persistent.tag')) } | Select-Object -First 1
        if (-not $storage) {
            Write-Host 'No persistent project volume was found. Create Volterra-persistent.tag on a writable data volume and run this script again.'
            exit 1
        }
        $env:VOLTERRA_STATE_DIR = Join-Path $storage.Root 'VolterraState'
    } else { $env:VOLTERRA_STATE_DIR = "$env:SystemDrive\VolterraState" }
    $env:CODEX_HOME = Join-Path $env:VOLTERRA_STATE_DIR 'codex'
    $env:GH_CONFIG_DIR = Join-Path $env:VOLTERRA_STATE_DIR 'github'
    $env:VOLTERRA_AUTOSTART = '1'
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'safe.directory'
    $env:GIT_CONFIG_VALUE_0 = $taskRoot
    $git = Join-Path $tools 'git\cmd\git.exe'
    New-Item -ItemType Directory -Path $env:VOLTERRA_STATE_DIR -Force | Out-Null
    $updater = Join-Path $tools '..\bootstrap\Apply-SourceUpdate.mjs'
    if (-not (Test-Path -LiteralPath $updater)) { throw 'The sealed source recovery helper is missing.' }
    & $node $updater $env:VOLTERRA_STATE_DIR $taskRoot apply $git
    if ($LASTEXITCODE -ne 0) { throw 'The staged source update was deferred. The previous system files have been retained.' }
    $probe = Join-Path $PSScriptRoot 'Test-BootRuntime.ps1'
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @('-NoProfile','-File',('"{0}"' -f $probe),'-Port',[string]$Port)
}
$env:VOLTERRA_PORT = [string]$Port
$env:VOLTERRA_BROWSER_PROFILE = if ($env:VOLTERRA_STATE_DIR) { Join-Path $env:VOLTERRA_STATE_DIR 'browser' } else { Join-Path $env:LOCALAPPDATA 'VolterraWorkspace\browser' }
Write-Host "Microsoft Volterra workspace: http://127.0.0.1:$Port"
Write-Host 'Live progress appears in this terminal and in the workspace. Use Ctrl+` in the app to open the live panel.'
Write-Host 'ChatGPT and GitHub use separate official browser sign-ins. No API key is required.'
if (-not $NoBrowser) {
    $chrome = Join-Path $tools 'chrome\chrome.exe'
    if (Test-Path -LiteralPath $chrome) {
        $profile = $env:VOLTERRA_BROWSER_PROFILE
        Start-Process -FilePath $chrome -ArgumentList @('--no-first-run', '--start-fullscreen', ('--user-data-dir="{0}"' -f $profile), "--app=http://127.0.0.1:$Port/?screen=connections")
    } else { Start-Process -FilePath "http://127.0.0.1:$Port/?screen=connections" }
}
& $node (Join-Path $taskRoot 'app\server.mjs')
exit $LASTEXITCODE
