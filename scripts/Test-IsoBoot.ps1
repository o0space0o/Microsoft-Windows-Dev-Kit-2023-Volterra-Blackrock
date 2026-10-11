#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidateSet('Prepare','Inspect','Stop')][string]$Phase='Prepare')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace 'build\development-006'
$owned = Join-Path $build 'iso-test'
$vmName = 'Microsoft Volterra development ISO test 006'
New-Item -ItemType Directory -Path $owned -Force | Out-Null
function Save($File,$Object) { $Object | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $owned $File) -Encoding utf8 }
try {
    Import-Module Hyper-V
    if ($Phase -eq 'Prepare') {
        if (Get-VM -Name $vmName -ErrorAction SilentlyContinue) { throw 'An existing test VM will not be replaced.' }
        $iso = Join-Path $build 'Microsoft-Volterra-development-arm64.iso'
        $receipt = Get-Content -LiteralPath (Join-Path $build 'iso-receipt.json') -Raw | ConvertFrom-Json
        if ((Get-FileHash -LiteralPath $iso).Hash -ne $receipt.sha256) { throw 'ISO hash changed.' }
        $data = Join-Path $owned 'persistent.vhdx'
        if (Test-Path -LiteralPath $data) { throw 'The existing persistent disk will not be overwritten.' }
        $v = New-VHD -Path $data -SizeBytes 4GB -Dynamic
        $disk = (Mount-VHD -Path $data -Passthru) | Get-Disk
        if ($disk.Number -eq 0 -or $disk.PartitionStyle -ne 'RAW' -or $disk.Size -ne 4GB -or (Get-VHD -Path $data).DiskIdentifier -ne $v.DiskIdentifier) { throw 'New test virtual disk identity mismatch.' }
        Initialize-Disk -Number $disk.Number -PartitionStyle GPT | Out-Null
        $part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
        Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel VOLTERRA_STATE -Confirm:$false | Out-Null
        [IO.File]::WriteAllText(($part.DriveLetter+':\Volterra-persistent.tag'),'development-006',[Text.Encoding]::ASCII)
        Dismount-VHD -Path $data
        $vm = New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 6GB -Path $owned -NoVHD
        Set-VM -VM $vm -AutomaticCheckpointsEnabled $false
        Set-VMProcessor -VM $vm -Count 4
        Remove-VMNetworkAdapter -VM $vm
        Add-VMHardDiskDrive -VM $vm -Path $data
        Add-VMDvdDrive -VM $vm -Path $iso
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice (Get-VMDvdDrive -VM $vm)
        Save 'identity.json' @{ id=[string]$vm.Id; name=$vmName; data=$data; iso=$iso; isoSHA256=$receipt.sha256; physicalDiskAttached=$false; network=$false }
        Start-VM -VM $vm
    } else {
        $identity = Get-Content -LiteralPath (Join-Path $owned 'identity.json') -Raw | ConvertFrom-Json
        $vm = Get-VM -Id $identity.id
        if ($vm.Name -ne $vmName) { throw 'Test VM identity changed.' }
        if ($Phase -eq 'Stop') { Stop-VM -VM $vm }
        else {
            Save 'status.json' @{ state=[string]$vm.State; uptime=[string]$vm.Uptime; status=$vm.Status }
            & (Join-Path $PSScriptRoot 'Capture-VM.ps1') -VMId $vm.Id -OutputFile (Join-Path $owned 'screen.png')
        }
    }
    Save ($Phase+'-result.json') @{ status='passed' }
} catch { Save ($Phase+'-result.json') @{ status='failed'; error=$_.Exception.Message }; exit 1 }
