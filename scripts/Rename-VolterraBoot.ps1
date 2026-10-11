#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ReportDirectory)
$ErrorActionPreference = 'Stop'
$report = [IO.Path]::GetFullPath($ReportDirectory)
New-Item -ItemType Directory -Path $report -Force | Out-Null
$bcdedit = "$env:SystemRoot\System32\bcdedit.exe"
$candidate = '{190abd8c-bb5f-11f1-8b6a-8ceb947c145e}'
$resume = '{dfa1b5fe-c53b-11f1-8b14-806e6f6e6963}'
function Invoke-Bcd([string[]]$Arguments) {
    $result = & $bcdedit @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "BCDEdit failed: $result" }
    return ($result -join [Environment]::NewLine)
}
try {
    $before = Invoke-Bcd @('/enum', 'all', '/v')
    $before | Set-Content -LiteralPath (Join-Path $report 'before.txt') -Encoding utf8
    $candidateBefore = Invoke-Bcd @('/enum', $candidate, '/v')
    if ($candidateBefore -notmatch 'partition=A:' -or $candidateBefore -notmatch 'VolBlickro - untested ARM64 candidate 002') {
        throw 'The candidate differs from the inspected A: boot entry. No rename was attempted.'
    }
    $backup = Join-Path $report 'boot-configuration.bcd'
    if (Test-Path -LiteralPath $backup) { throw 'An existing backup will not be overwritten.' }
    Invoke-Bcd @('/export', $backup) | Set-Content -LiteralPath (Join-Path $report 'backup-result.txt')
    Invoke-Bcd @('/set', $candidate, 'description', 'Microsoft Volterra') | Out-Null
    Invoke-Bcd @('/set', $resume, 'description', 'Microsoft Volterra') | Out-Null
    $after = Invoke-Bcd @('/enum', 'all', '/v')
    $after | Set-Content -LiteralPath (Join-Path $report 'after.txt') -Encoding utf8
    $verified = Invoke-Bcd @('/enum', $candidate, '/v')
    if ($verified -notmatch 'description\s+Microsoft Volterra') { throw 'Rename verification failed.' }
    Get-ChildItem -LiteralPath 'A:\' -Force | Select-Object Name, Mode, Length |
        ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $report 'target-files.json') -Encoding utf8
    @{ status = 'complete'; entry = $candidate; description = 'Microsoft Volterra'; backup = $backup; time = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json') -Encoding utf8
} catch {
    @{ status = 'failed'; error = $_.Exception.Message; time = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $report 'status.json') -Encoding utf8
    exit 1
}
