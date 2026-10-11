#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReportDirectory
)
$ErrorActionPreference = 'Stop'
$report = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $report -Force | Out-Null
try {
    $boot = & "$env:SystemRoot\System32\bcdedit.exe" /enum all /v 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Boot inspection failed: $boot" }
    $boot | Set-Content -LiteralPath (Join-Path $report 'boot-entries.txt') -Encoding utf8
    Get-Disk | Select-Object Number, FriendlyName, PartitionStyle, Size, IsBoot, IsSystem |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $report 'disks.json') -Encoding utf8
    Get-Partition | Select-Object DiskNumber, PartitionNumber, DriveLetter, Type, GptType, Size, Offset, IsBoot, IsSystem |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $report 'partitions.json') -Encoding utf8
    try {
        Get-BitLockerVolume | Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionPercentage |
            ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $report 'encryption-status.json') -Encoding utf8
    } catch { $_.Exception.Message | Set-Content -LiteralPath (Join-Path $report 'encryption-inspection-error.txt') }
    Get-VM | Select-Object Name, State, Generation, ProcessorCount, MemoryStartup, Path |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $report 'virtual-machines.json') -Encoding utf8
    $dism = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM\dism.exe'
    if (Test-Path -LiteralPath 'D:\ValidationOS.wim') {
        & $dism /English /Get-WimInfo /WimFile:D:\ValidationOS.wim 2>&1 |
            Set-Content -LiteralPath (Join-Path $report 'validation-image-info.txt') -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw "Image inspection failed ($LASTEXITCODE)" }
    }
    @{ status = 'complete'; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $report 'status.json') -Encoding utf8
} catch {
    @{ status = 'failed'; error = $_.Exception.Message; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $report 'status.json') -Encoding utf8
    exit 1
}
