[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='devices'; status='blocked'; observedAt=$null
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }
    devices=@(); error=$null
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Device enumeration can still work when OS metadata is unavailable.
}
try {
    # Query only the local read-only inventory. Do not invoke device methods,
    # install drivers, accept filter/command text or contact a remote machine.
    $report.devices = @(Get-CimInstance -ClassName Win32_PnPEntity -Property DeviceID,Name,PNPClass,Status,Present,ConfigManagerErrorCode -ErrorAction Stop | ForEach-Object {
        [ordered]@{
            instanceId=[string]$_.DeviceID; name=$_.Name; deviceClass=$_.PNPClass; status=$_.Status
            present=$_.Present; problemCode=$_.ConfigManagerErrorCode
        }
    })
    $report.status = 'passed'
} catch {
    $report.devices = @()
    $report.error = @{ stage='Device enumeration'; message=$_.Exception.Message }
}
$report.observedAt = [DateTime]::UtcNow.ToString('o')
$report | ConvertTo-Json -Depth 5 -Compress
