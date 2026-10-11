param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = 'Stop'
$address = [Uri]$Url
if ($address.Scheme -ne 'https' -and -not ($address.Scheme -eq 'http' -and $address.Host -eq '127.0.0.1')) { throw 'Unsupported browser address' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$chrome = Join-Path $taskRoot 'private\tools\chrome\chrome.exe'
if (Test-Path -LiteralPath $chrome) {
    $arguments = @('--new-window', '--no-first-run', $address.AbsoluteUri)
    if ($env:VOLTERRA_BROWSER_PROFILE) { $arguments += ('--user-data-dir="{0}"' -f $env:VOLTERRA_BROWSER_PROFILE) }
    Start-Process -FilePath $chrome -ArgumentList $arguments
} else { Start-Process -FilePath $address.AbsoluteUri }
