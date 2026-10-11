#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$Resume,[switch]$Collected)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace 'build\development-006'
function Progress($Phase,$Status,$ErrorText='') { @{ phase=$Phase; status=$Status; error=$ErrorText; utc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'pipeline.json') -Encoding utf8 }
try {
    Progress 'Starting isolated technician VM' 'running'
    if (-not $Resume -and -not $Collected) {
        & (Join-Path $PSScriptRoot 'Build-Technician.ps1') -Phase Start
        if ((Get-Content -LiteralPath (Join-Path $build 'Start-result.json') -Raw | ConvertFrom-Json).status -ne 'passed') { throw 'Technician start failed.' }
    }
    $identity = Get-Content -LiteralPath (Join-Path $build 'identity.json') -Raw | ConvertFrom-Json
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    if (-not $Collected) { do {
        Start-Sleep -Seconds 15
        $vm = Get-VM -Id $identity.vmId
        Progress "Composing images in ARM64 Windows PE ($($vm.State), $($vm.Uptime))" 'running'
        $capture = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList @('-NoProfile','-File',('"{0}"' -f (Join-Path $PSScriptRoot 'Capture-VM.ps1')),'-VMId',$identity.vmId,'-OutputFile',('"{0}"' -f (Join-Path $build 'technician.png'))) -PassThru
        if (-not $capture.WaitForExit(10000)) { $capture.Kill() }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Technician is still running after 30 minutes. No VM or disk was forced off.' }
    } while ($vm.State -ne 'Off') }
    Progress 'Collecting offline images and servicing evidence' 'running'
    if (-not $Collected) { & (Join-Path $PSScriptRoot 'Build-Technician.ps1') -Phase Collect }
    if ((Get-Content -LiteralPath (Join-Path $build 'Collect-result.json') -Raw | ConvertFrom-Json).status -ne 'passed') { throw 'Guest image servicing failed.' }
    Progress 'Finalizing automatic workspace and boot runtime checks' 'running'
    & (Join-Path $PSScriptRoot 'Finalize-ImagePayload.ps1')
    if ((Get-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Raw | ConvertFrom-Json).status -ne 'passed') { throw 'Final application payload failed.' }
    Progress 'Building private ARM64 boot ISO' 'running'
    & (Join-Path $PSScriptRoot 'Build-Iso.ps1')
    if ((Get-Content -LiteralPath (Join-Path $build 'Iso-result.json') -Raw | ConvertFrom-Json).status -ne 'passed') { throw 'ISO creation failed.' }
    Progress 'ISO created; VM boot verification pending' 'ready'
} catch { Progress 'Image build stopped' 'failed' $_.Exception.Message; exit 1 }
