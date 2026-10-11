#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidateSet('Prepare','Inspect','Stop')][string]$Phase='Prepare',
    [ValidatePattern('\Adevelopment-[0-9]{3}\z')][string]$BuildName='development-006'
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = Join-Path $workspace 'private\tools\node.exe'
$plan = $null
function Read-Plan([string]$SelectedPhase) {
    $json = & $node (Join-Path $PSScriptRoot 'Plan-IsoBoot.mjs') $BuildName $SelectedPhase
    if ($LASTEXITCODE -ne 0) { throw 'Selected ISO test receipt/identity validation failed.' }
    return ($json | ConvertFrom-Json)
}
function Save($File,$Object,[bool]$NewFile=$false) {
    # Replace a directory entry rather than writing through an existing link.
    $target = Join-Path $owned $File
    $temporary = Join-Path $owned ([Guid]::NewGuid().ToString()+'.tmp')
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Depth 8))
        $stream.Write($bytes,0,$bytes.Length)
    } finally { $stream.Dispose() }
    if (-not $NewFile -and [IO.File]::Exists($target)) { [IO.File]::Replace($temporary,$target,$null) }
    else { [IO.File]::Move($temporary,$target) }
}
function Assert-TestVM($VM,$Selection) {
    if ([string]$VM.Id -ne $Selection.vmId -or $VM.Name -ne $Selection.vmName -or $VM.Generation -ne 2) { throw 'Test VM identity changed.' }
    $firmware = Get-VMFirmware -VM $VM
    if ([string]$firmware.SecureBoot -ne 'On' -or $firmware.SecureBootTemplate -ne 'MicrosoftWindows') { throw 'Test VM Secure Boot changed.' }
    if (@(Get-VMNetworkAdapter -VM $VM).Count -ne 0) { throw 'The isolated test VM has a network adapter.' }
    $drives = @(Get-VMHardDiskDrive -VM $VM)
    if ($drives.Count -ne 1 -or $null -ne $drives[0].DiskNumber -or -not $drives[0].Path -or [IO.Path]::GetFullPath($drives[0].Path) -ne $Selection.data) { throw 'Unexpected virtual/physical disk attachment.' }
    $dvd = @(Get-VMDvdDrive -VM $VM)
    if ($dvd.Count -ne 1 -or -not $dvd[0].Path -or [IO.Path]::GetFullPath($dvd[0].Path) -ne $Selection.iso) { throw 'Test VM ISO attachment changed.' }
    $vhd = Get-VHD -Path $Selection.data
    if ($vhd.VhdType -ne 'Dynamic' -or $vhd.Size -ne 4GB -or $vhd.ParentPath) { throw 'Unexpected test virtual disk.' }
}
function Invoke-InspectionCapture($VM,$Selection,[scriptblock]$Collect) {
    $captureId = [Guid]::NewGuid().ToString()
    $outputFile = Join-Path $Selection.owned 'screen.png'
    $capture = (& $Collect $captureId $outputFile ([string]$VM.Id)) | ConvertFrom-Json
    if ($capture.version -ne 1 -or $capture.status -ne 'passed' -or $capture.captureId -ne $captureId -or $capture.vmId -ne [string]$VM.Id -or $capture.path -ne $outputFile) { throw 'Capture did not confirm this Inspect invocation.' }
    if ($capture.bytes -le 0 -or (Get-Item -LiteralPath $outputFile).Length -ne $capture.bytes -or (Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash -ne $capture.sha256) { throw 'Fresh Inspect capture hash/size changed.' }
    return $capture
}
try {
    # This read-only helper validates the selected files before any Hyper-V call.
    $plan = Read-Plan $Phase
    $owned = $plan.owned
    $vmName = $plan.vmName
    $iso = $plan.iso
    $data = $plan.data
    New-Item -ItemType Directory -Path $owned -Force | Out-Null
    Import-Module Hyper-V
    if ($Phase -eq 'Prepare') {
        if (Get-VM -Name $vmName -ErrorAction SilentlyContinue) { throw 'An existing test VM will not be replaced.' }
        if (Test-Path -LiteralPath $data) { throw 'The existing persistent disk will not be overwritten.' }
        $v = New-VHD -Path $data -SizeBytes 4GB -Dynamic
        $disk = (Mount-VHD -Path $data -Passthru) | Get-Disk
        if ($disk.Number -eq 0 -or $disk.PartitionStyle -ne 'RAW' -or $disk.Size -ne 4GB -or (Get-VHD -Path $data).DiskIdentifier -ne $v.DiskIdentifier) { throw 'New test virtual disk identity mismatch.' }
        Initialize-Disk -Number $disk.Number -PartitionStyle GPT | Out-Null
        $part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
        Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel VOLTERRA_STATE -Confirm:$false | Out-Null
        [IO.File]::WriteAllText(($part.DriveLetter+':\Volterra-persistent.tag'),$BuildName,[Text.Encoding]::ASCII)
        Dismount-VHD -Path $data
        $vm = New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 6GB -Path $owned -NoVHD
        Set-VM -VM $vm -AutomaticCheckpointsEnabled $false
        Set-VMProcessor -VM $vm -Count 4
        Remove-VMNetworkAdapter -VM $vm
        Add-VMHardDiskDrive -VM $vm -Path $data
        Add-VMDvdDrive -VM $vm -Path $iso
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice (Get-VMDvdDrive -VM $vm)
        Save 'identity.json' @{ version=2; buildName=$BuildName; id=[string]$vm.Id; name=$vmName; data=$data; iso=$iso; isoSHA256=$plan.isoSHA256; isoReceipt=$plan.receiptFile; isoReceiptSHA256=$plan.isoReceiptSHA256; sourceCommit=$plan.sourceCommit; physicalDiskAttached=$false; network=$false } $true
        $verified = Read-Plan 'Inspect'
        if ($verified.sourceCommit -ne $plan.sourceCommit -or $verified.isoReceiptSHA256 -ne $plan.isoReceiptSHA256 -or $verified.vmId -ne [string]$vm.Id) { throw 'ISO selection changed during preparation.' }
        Assert-TestVM $vm $verified
        Start-VM -VM $vm
    } else {
        $vm = Get-VM -Id $plan.vmId
        Assert-TestVM $vm $plan
        if ($Phase -eq 'Stop') { Stop-VM -VM $vm }
        else {
            Save 'status.json' @{ state=[string]$vm.State; uptime=[string]$vm.Uptime; status=$vm.Status }
            $capture = Invoke-InspectionCapture $vm $plan {
                param($CaptureId,$OutputFile,$VMId)
                & (Join-Path $PSScriptRoot 'Capture-VM.ps1') -VMId $VMId -OutputFile $OutputFile -CaptureId $CaptureId
            }
        }
    }
    Save ($Phase+'-result.json') @{ status='passed'; phase=$Phase; buildName=$BuildName; sourceCommit=$plan.sourceCommit; sourceBinding=$plan.sourceBinding; isoSHA256=$plan.isoSHA256; isoReceiptSHA256=$plan.isoReceiptSHA256; capture=$capture; bootAccepted=$false; runtimeAccepted=$false }
} catch {
    if ($plan -and (Test-Path -LiteralPath $owned -PathType Container)) { Save ($Phase+'-result.json') @{ status='failed'; error=$_.Exception.Message; bootAccepted=$false; runtimeAccepted=$false } }
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
