[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='processes'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o')
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }; processes=@(); error=$null
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Process enumeration may work without edition metadata.
}
$records = @()
try {
    # Fixed local enumeration. Filters are applied by the helper after collection.
    $records = @(Get-Process -ErrorAction Stop)
    if ($records.Count -gt 4096) { throw 'The local API returned too many processes.' }
    $report.processes = @($records | ForEach-Object {
        $processRecord = $_
        $processId = $processRecord.Id
        if ($processId -isnot [int] -or $processId -lt 0) { throw 'The local API returned an unsupported process ID.' }
        $entry = [ordered]@{ pid=$processId; name=[string]$processRecord.ProcessName; sessionId=$null; workingSetBytes=$null }
        # Optional getters can fail for protected or exited processes. Preserve null,
        # rather than reporting zero or discarding an otherwise identified process.
        try {
            $session = $processRecord.SessionId
            if ($session -is [int] -and $session -ge 0) { $entry.sessionId = $session }
        } catch { }
        try {
            $workingSet = $processRecord.WorkingSet64
            if ($workingSet -is [long] -and $workingSet -ge 0) { $entry.workingSetBytes = $workingSet.ToString([Globalization.CultureInfo]::InvariantCulture) }
        } catch { }
        $entry
    })
    $report.status = 'passed'
} catch {
    $report.processes = @()
    $report.error = @{ stage='Local process enumeration'; message=$_.Exception.Message }
} finally {
    foreach ($record in $records) { if ($record -is [IDisposable]) { $record.Dispose() } }
}
$report | ConvertTo-Json -Depth 5 -Compress
