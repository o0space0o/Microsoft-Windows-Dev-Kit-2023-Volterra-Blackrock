[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='service-dependencies'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o')
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }
    services=@(); error=$null
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Unknown OS metadata does not prevent a dependency read.
}
$local = @()
try {
    # No remote target, supplied name, recursive traversal or service operation.
    $local = @(Get-Service -ErrorAction Stop)
    if ($local.Count -gt 4096) { throw 'Service enumeration exceeded the limit.' }
    $relationshipReadings = 0
    $report.services = @(foreach ($service in $local) {
        if ($null -eq $service) { throw 'Service enumeration returned a missing row.' }
        $required = @(); $dependents = @()
        try {
            $required = $service.ServicesDependedOn
            $dependents = $service.DependentServices
            if ($null -eq $required -or $null -eq $dependents) { throw 'The provider returned missing dependency lists.' }
            if ($required.Count -gt 4096 -or $dependents.Count -gt 4096) { throw 'A dependency list exceeded the limit.' }
            $relationshipReadings += $required.Count + $dependents.Count
            if ($relationshipReadings -gt 16384) { throw 'Dependency collection exceeded the relationship limit.' }
            [ordered]@{
                name=[string]$service.Name; displayName=[string]$service.DisplayName
                required=@($required | ForEach-Object {
                    if ($null -eq $_) { throw 'The provider returned a missing required-service identity.' }
                    [string]$_.Name
                })
                dependents=@($dependents | ForEach-Object {
                    if ($null -eq $_) { throw 'The provider returned a missing dependent-service identity.' }
                    [string]$_.Name
                })
            }
        } finally {
            foreach ($related in (@($required) + @($dependents))) {
                if ($null -ne $related) { $related.Dispose() }
            }
        }
    })
    $report.status = 'passed'
} catch {
    $report.services = @()
    $report.error = @{ stage='Service dependencies'; message=$_.Exception.Message }
} finally {
    foreach ($service in $local) { if ($null -ne $service) { $service.Dispose() } }
}
$report | ConvertTo-Json -Depth 6 -Compress
