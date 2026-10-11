#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidatePattern('^development-[0-9]{3}$')][string]$BuildName='development-007')
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$base=Join-Path $workspace 'build\development-006'
$build=Join-Path $workspace ('build\'+$BuildName)
function Save($value) { $value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'refresh-result.json') -Encoding utf8 }
try {
    if (Test-Path -LiteralPath $build) { throw 'A helper refresh build already exists and will not be overwritten.' }
    $receipt=Get-Content -LiteralPath (Join-Path $base 'image-receipt.json') -Raw | ConvertFrom-Json
    foreach ($kind in @('boot','install')) {
        if ((Get-FileHash -LiteralPath (Join-Path $base ('output\'+$kind+'.wim'))).Hash -ne $receipt.($kind+'SHA256')) { throw 'The sealed base image hash changed.' }
    }
    New-Item -ItemType Directory -Path (Join-Path $build 'output') | Out-Null
    foreach ($file in @('boot.wim','install.wim','result.json')) { Copy-Item -LiteralPath (Join-Path $base ('output\'+$file)) -Destination (Join-Path $build 'output') }
    Copy-Item -LiteralPath (Join-Path $base 'image-receipt.json') -Destination $build
    Save @{status='running';base='development-006';build=$BuildName;phase='Refreshing original helper source only'}
    & (Join-Path $PSScriptRoot 'Finalize-ImagePayload.ps1') -BuildName $BuildName
    if ($LASTEXITCODE -ne 0) { throw 'File-only helper overlay failed.' }
    Save @{status='running';base='development-006';build=$BuildName;phase='Building private ARM64 ISO'}
    & (Join-Path $PSScriptRoot 'Build-Iso.ps1') -BuildName $BuildName
    if ($LASTEXITCODE -ne 0) { throw 'Refreshed ISO creation failed.' }
    Save @{status='passed';base='development-006';build=$BuildName;bootTested=$false;physicalTested=$false}
} catch {
    if (Test-Path -LiteralPath $build) { Save @{status='failed';error=$_.Exception.Message} }
    else { Write-Error $_.Exception.Message }
    exit 1
}
