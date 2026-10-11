[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='logs'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o'); maxEvents=50
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }
    channels=@()
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # The local event API can work without edition metadata.
}
foreach ($name in @('System', 'Application')) {
    $channel = [ordered]@{ name=$name; status='blocked'; events=@(); error=$null }
    $records = @()
    try {
        try {
            # Fixed local channels and limit; no paths, remote computer, credentials,
            # user filters, log mutations or Security channel reads are accepted.
            $records = @(Get-WinEvent -LogName $name -MaxEvents 50 -ErrorAction Stop)
        } catch {
            if ($_.FullyQualifiedErrorId -ne 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { throw }
        }
        $channel.events = @($records | ForEach-Object {
            # Do not evaluate Message, Properties, UserId, MachineName or ToXml().
            [ordered]@{
                channel=[string]$_.LogName; provider=[string]$_.ProviderName; id=[int]$_.Id
                recordId=if ($null -eq $_.RecordId) { $null } else { $_.RecordId.ToString([Globalization.CultureInfo]::InvariantCulture) }
                level=if ($null -eq $_.Level) { $null } else { [int]$_.Level }
                createdAt=if ($null -eq $_.TimeCreated) { $null } else { $_.TimeCreated.ToUniversalTime().ToString('o') }
            }
        })
        $channel.status = 'passed'
    } catch {
        $channel.events = @()
        $channel.error = @{ stage="$name event query"; message=$_.Exception.Message }
    } finally {
        foreach ($record in $records) { if ($record -is [IDisposable]) { $record.Dispose() } }
    }
    $report.channels += $channel
}
if (@($report.channels | Where-Object { $_.status -ne 'passed' }).Count -eq 0) { $report.status = 'passed' }
$report | ConvertTo-Json -Depth 7 -Compress
