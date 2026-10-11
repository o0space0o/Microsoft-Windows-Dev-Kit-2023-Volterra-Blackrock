#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidateSet('Prepare','Start','Inspect','Collect')][string]$Phase = 'Prepare')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$owned = Join-Path $workspace 'build\development-006'
$boot = Join-Path $owned 'boot.vhdx'; $data = Join-Path $owned 'data.vhdx'
$vmName = 'Microsoft Volterra development technician 006'
$dism = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM\dism.exe'
New-Item -ItemType Directory -Path $owned -Force | Out-Null
function Save([string]$File, $Value) { [IO.File]::WriteAllText((Join-Path $owned $File), ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false)) }
function Status([string]$Text) { Save 'progress.json' @{ phase=$Phase; action=$Text; utc=[DateTime]::UtcNow.ToString('o') } }
function Dism([string]$Name, [string[]]$Arguments) {
    Status $Name
    & $dism /English @Arguments "/LogPath:$owned\$Name.log" > (Join-Path $owned "$Name-output.txt")
    if ($LASTEXITCODE -notin @(0,3010)) { throw "DISM $Name failed ($LASTEXITCODE)." }
}
function CopyTree([string]$From, [string]$To, [string]$Name) {
    & robocopy.exe $From $To /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ /NP "/LOG:$owned\$Name.log" | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Copy $Name failed." }
}
function PartitionRoot([string]$Path, [switch]$ReadOnly) {
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($owned+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Virtual disk leaves this build directory.' }
    $v = Get-VHD -Path $full
    if ($v.ParentPath) { throw 'Only an owned base virtual disk is allowed.' }
    $disk = if ($v.Attached) { Get-Disk -Number $v.DiskNumber } else { (Mount-VHD -Path $full -ReadOnly:$ReadOnly -Passthru) | Get-Disk }
    if ($disk.Number -eq 0 -or ($ReadOnly -and -not $disk.IsReadOnly)) { throw 'Unexpected virtual disk identity or access mode.' }
    $part = @($disk | Get-Partition | Where-Object DriveLetter)
    if ($part.Count -ne 1) { throw 'The owned virtual disk has an ambiguous partition.' }
    return $part[0].DriveLetter + ':\'
}
try {
    Import-Module Hyper-V
    if ($Phase -eq 'Prepare') {
        if ((Test-Path -LiteralPath $boot) -or (Test-Path -LiteralPath $data) -or (Get-VM -Name $vmName -ErrorAction SilentlyContinue)) { throw 'An existing technician build will not be overwritten.' }
        $sourceBoot = 'C:\Users\_420\Documents\VolBlickro\build\vb-arm64-candidate-002\technician\boot.vhdx'
        if ((Get-VHD -Path $sourceBoot).ParentPath) { throw 'The clean Windows PE source must be a base disk.' }
        Status 'Copying clean ARM64 Windows PE boot media and replacing its startup with this project script'
        Copy-Item -LiteralPath $sourceBoot -Destination $boot
        $bootRoot = PartitionRoot $boot
        $peMount = Join-Path $owned 'pe-mount'
        New-Item -ItemType Directory -Path $peMount | Out-Null
        Dism 'mount-pe' @('/Mount-Image', "/ImageFile:$bootRoot\sources\boot.wim", '/Index:1', "/MountDir:$peMount")
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Technician-Startup.cmd') -Destination (Join-Path $peMount 'Technician-Startup.cmd')
        [IO.File]::WriteAllText((Join-Path $peMount 'Windows\System32\winpeshl.ini'), "[LaunchApps]`r`n%SYSTEMROOT%\System32\cmd.exe, /d /c X:\Technician-Startup.cmd`r`n", [Text.Encoding]::ASCII)
        Dism 'commit-pe' @('/Unmount-Image', "/MountDir:$peMount", '/Commit', '/CheckIntegrity')
        Dismount-VHD -Path $boot
        Status 'Creating and staging an isolated virtual data disk'
        $v = New-VHD -Path $data -SizeBytes 40GB -Dynamic
        $disk = (Mount-VHD -Path $data -Passthru) | Get-Disk
        if ($disk.Number -eq 0 -or $disk.PartitionStyle -ne 'RAW' -or $disk.Size -ne 40GB -or (Get-VHD -Path $data).DiskIdentifier -ne $v.DiskIdentifier) { throw 'New virtual data disk identity mismatch.' }
        Initialize-Disk -Number $disk.Number -PartitionStyle GPT | Out-Null
        $part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
        Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel VOLTERRA006 -Confirm:$false | Out-Null
        $dataRoot = $part.DriveLetter + ':\'
        [IO.File]::WriteAllText((Join-Path $dataRoot 'Volterra-development-006.tag'), 'development-006', [Text.Encoding]::ASCII)
        New-Item -ItemType Directory -Path (Join-Path $dataRoot 'Output') | Out-Null
        Copy-Item -LiteralPath 'D:\ValidationOS.wim' -Destination $dataRoot
        CopyTree 'D:\GenImage\Tools\DISM\ARM64' (Join-Path $dataRoot 'Tools') 'dism-copy'
        $base = Join-Path $workspace 'build\development-004'
        CopyTree (Join-Path $base 'boot\pkgs') (Join-Path $dataRoot 'Cabs') 'cabs-copy'
        $inventory = Get-Content -LiteralPath (Join-Path $base 'driver-inventory.json') -Raw | ConvertFrom-Json
        $selected = @($inventory | Where-Object ClassName -ne 'Firmware')
        $signatures = @()
        foreach ($driver in $selected) {
            $folder = Split-Path (Split-Path $driver.OriginalFileName) -Leaf
            $from = Join-Path $base "drivers\$folder"
            $cats = @(Get-ChildItem -LiteralPath $from -Filter '*.cat' -Recurse -File)
            if ($cats.Count -eq 0) { throw "Driver catalog missing: $folder" }
            foreach ($cat in $cats) {
                $sig = Get-AuthenticodeSignature -LiteralPath $cat.FullName
                if ($sig.Status -ne 'Valid') { throw "Driver catalog is not verified: $folder ($($sig.Status))" }
                $signatures += @{ file=$cat.Name; driver=$folder; status=[string]$sig.Status; sha256=(Get-FileHash -LiteralPath $cat.FullName).Hash }
            }
            CopyTree $from (Join-Path $dataRoot "Drivers\$folder") ("driver-"+$driver.Driver)
        }
        Save 'drivers.json' @{ included=$selected; excluded=@($inventory | Where-Object ClassName -eq 'Firmware'); catalogs=$signatures }
        $payload = Join-Path $dataRoot 'Payload'
        New-Item -ItemType Directory -Path $payload | Out-Null
        foreach ($item in @('app','design\approved-v1','private\tools')) { CopyTree (Join-Path $workspace $item) (Join-Path $payload $item) ('payload-'+($item -replace '\\','-')) }
        New-Item -ItemType Directory -Path (Join-Path $payload 'scripts') | Out-Null
        foreach ($file in @('Start-Volterra.ps1','Open-Browser.ps1','Choose-Folder.ps1','Protect-Credential.ps1','Get-RestartStatus.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $payload 'scripts') }
        foreach ($file in @('PROJECT_BRIEF.md','AGENTS.md','package.json','.gitignore')) { Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $payload }
        Copy-Item -LiteralPath 'D:\license.rtf' -Destination (Join-Path $payload 'Microsoft-Validation-OS-license.rtf')
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Guest-Build.cmd') -Destination $dataRoot
        Copy-Item -LiteralPath (Join-Path $workspace 'image\Volterra-Startup.cmd') -Destination $dataRoot
        $files = @(Get-ChildItem -LiteralPath $payload -File -Recurse | ForEach-Object { @{ path=$_.FullName.Substring($payload.Length+1); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash } })
        Save 'payload-manifest.json' @{ files=$files; credentialProfilesIncluded=$false; automaticSystemWorkspace=$true }
        Dismount-VHD -Path $data
        $vm = New-VM -Name $vmName -Generation 2 -MemoryStartupBytes 6GB -VHDPath $boot -Path $owned
        Set-VM -VM $vm -AutomaticCheckpointsEnabled $false
        Set-VMProcessor -VM $vm -Count 4
        Remove-VMNetworkAdapter -VM $vm
        Add-VMHardDiskDrive -VM $vm -Path $data
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
        Save 'identity.json' @{ vmId=[string]$vm.Id; name=$vmName; boot=$boot; data=$data; bootId=(Get-VHD -Path $boot).DiskIdentifier; dataId=(Get-VHD -Path $data).DiskIdentifier; physicalDisksAttached=$false; network=$false }
    } else {
        $id = Get-Content -LiteralPath (Join-Path $owned 'identity.json') -Raw | ConvertFrom-Json
        $vm = Get-VM -Id $id.vmId
        if ($vm.Name -ne $vmName -or (Get-VHD -Path $data).DiskIdentifier -ne $id.dataId) { throw 'Technician identity changed.' }
        if ($Phase -eq 'Start') {
            if ($vm.State -ne 'Off') { throw 'VM is not off.' }
            $dataRoot = PartitionRoot $data
            try {
                Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Guest-Build.cmd') -Destination $dataRoot -Force
                $manifest = Get-Content -LiteralPath (Join-Path $owned 'payload-manifest.json') -Raw | ConvertFrom-Json
                foreach ($file in $manifest.files) {
                    $source = Join-Path $workspace $file.path
                    if (Test-Path -LiteralPath $source -PathType Leaf) {
                        $hash = (Get-FileHash -LiteralPath $source).Hash
                        if ($hash -ne $file.sha256) { Copy-Item -LiteralPath $source -Destination (Join-Path $dataRoot ('Payload\'+$file.path)) -Force; $file.sha256 = $hash }
                    }
                }
                Save 'payload-manifest.json' $manifest
            } finally { Dismount-VHD -Path $data }
            Start-VM -VM $vm
        }
        elseif ($Phase -eq 'Inspect') { Save 'vm-status.json' @{ state=[string]$vm.State; uptime=[string]$vm.Uptime; status=$vm.Status } }
        else {
            if ($vm.State -ne 'Off') { throw 'Wait for the technician to shut down before collection.' }
            $dataRoot = PartitionRoot $data -ReadOnly
            try {
                CopyTree (Join-Path $dataRoot 'Output') (Join-Path $owned 'output') 'collect-output'
                $result = Get-Content -LiteralPath (Join-Path $owned 'output\result.json') -Raw | ConvertFrom-Json
                if ($result.status -ne 'passed' -or $result.build -ne 'development-006') { throw 'Guest servicing failed; inspect output logs.' }
                Save 'image-receipt.json' @{ bootSHA256=(Get-FileHash -LiteralPath (Join-Path $owned 'output\boot.wim')).Hash; installSHA256=(Get-FileHash -LiteralPath (Join-Path $owned 'output\install.wim')).Hash; vmServiced=$true; physicalTested=$false }
            } finally { Dismount-VHD -Path $data }
        }
    }
    Save ($Phase+'-result.json') @{ status='passed'; utc=[DateTime]::UtcNow.ToString('o') }
} catch { Save ($Phase+'-result.json') @{ status='failed'; error=$_.Exception.Message; utc=[DateTime]::UtcNow.ToString('o') }; exit 1 }
