[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='services'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o')
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }
    services=@(); error=$null
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Service enumeration can still work when OS metadata is unavailable.
}
try {
    # Read only the local Service Control Manager; never accept command text,
    # change startup settings or start/stop a service in this collector.
    $report.services = @(Get-Service -ErrorAction Stop | ForEach-Object {
        [ordered]@{ name=[string]$_.Name; displayName=[string]$_.DisplayName; status=[string]$_.Status; startType=[string]$_.StartType }
    })
    $report.status = 'passed'
} catch {
    $report.services = @()
    $report.error = @{ stage='Service enumeration'; message=$_.Exception.Message }
}
$report | ConvertTo-Json -Depth 5 -Compress
