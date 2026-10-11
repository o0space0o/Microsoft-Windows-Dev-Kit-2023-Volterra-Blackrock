[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='drives'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o')
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }; drives=@(); error=$null
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Logical drive enumeration may work without edition metadata.
}
function Capacity-Text($value) {
    if ($null -eq $value) { return $null }
    if ($value -isnot [uint64]) { throw 'The local provider returned unsupported capacity bytes.' }
    return $value.ToString([Globalization.CultureInfo]::InvariantCulture)
}
try {
    # Fixed local read-only class and properties. Chat filters never enter this query.
    $records = @(Get-CimInstance -Namespace 'root/cimv2' -ClassName Win32_LogicalDisk -Property DeviceID,DriveType,VolumeName,FileSystem,Size,FreeSpace -OperationTimeoutSec 10 -ErrorAction Stop)
    if ($records.Count -gt 26) { throw 'The local provider returned too many logical drives.' }
    $report.drives = @($records | ForEach-Object {
        if ($null -eq $_ -or $_.DriveType -isnot [uint32]) { throw 'The local provider returned an incomplete logical drive.' }
        [ordered]@{
            id=[string]$_.DeviceID; driveType=$_.DriveType
            label=if ($null -eq $_.VolumeName) { $null } else { [string]$_.VolumeName }
            fileSystem=if ($null -eq $_.FileSystem) { $null } else { [string]$_.FileSystem }
            totalBytes=Capacity-Text $_.Size; freeBytes=Capacity-Text $_.FreeSpace
        }
    })
    $report.status = 'passed'
} catch {
    $report.drives = @()
    $report.error = @{ stage='Local logical drive enumeration'; message=$_.Exception.Message }
}
$report | ConvertTo-Json -Depth 5 -Compress
