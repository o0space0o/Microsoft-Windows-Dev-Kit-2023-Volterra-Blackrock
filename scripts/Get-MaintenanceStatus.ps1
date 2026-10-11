[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } elseif ($env:PROCESSOR_ARCHITECTURE) { $env:PROCESSOR_ARCHITECTURE } else { 'Unknown' }
$report = [ordered]@{
    version=1; kind='maintenance'; status='blocked'; observedAt=[DateTime]::UtcNow.ToString('o')
    system=@{ edition='Unknown'; build='Unknown'; architecture=$architecture }; checks=@()
}
try {
    $windows = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $report.system.edition = [string]$windows.EditionID
    $report.system.build = [string]$windows.CurrentBuildNumber
} catch { # Maintenance providers may work without edition metadata.
}
$update = [ordered]@{ id='windows-update'; status='blocked'; restartReported=$null; error=$null }
$information = $null
try {
    # Read this property only. Do not search, download, install or uninstall updates.
    $information = New-Object -ComObject Microsoft.Update.SystemInfo
    $required = $information.RebootRequired
    if ($required -isnot [bool]) { throw 'Windows Update returned an unsupported restart reading.' }
    $update.restartReported = $required
    $update.status = 'passed'
} catch {
    $update.error = @{ stage='Windows Update restart property'; message=$_.Exception.Message }
} finally {
    if ($null -ne $information) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($information) | Out-Null }
}
$report.checks += $update
$files = [ordered]@{ id='pending-file-operations'; status='blocked'; restartReported=$null; error=$null }
$key = $null
try {
    # Open the fixed Session Manager key for reading. A missing value is distinct
    # from a missing/unreadable key; never emit queued filenames or destinations.
    $key = Get-Item -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction Stop
    $files.restartReported = $false
    if ($key.GetValueNames() -contains 'PendingFileRenameOperations') {
        if ($key.GetValueKind('PendingFileRenameOperations') -ne [Microsoft.Win32.RegistryValueKind]::MultiString) { throw 'Pending file operations have an unsupported registry type.' }
        $pending = $key.GetValue('PendingFileRenameOperations')
        if ($pending -isnot [string[]] -or $pending.Count -gt 4096) { throw 'Pending file operations returned unsupported readings.' }
        $files.restartReported = @($pending | Where-Object { $_.Length -gt 0 }).Count -gt 0
    }
    $files.status = 'passed'
} catch {
    $files.restartReported = $null
    $files.error = @{ stage='Pending file operations'; message=$_.Exception.Message }
} finally {
    if ($null -ne $key) { $key.Close() }
}
$report.checks += $files
if (@($report.checks | Where-Object { $_.status -ne 'passed' }).Count -eq 0) { $report.status = 'passed' }
$report | ConvertTo-Json -Depth 6 -Compress
