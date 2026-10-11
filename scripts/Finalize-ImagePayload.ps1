#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidatePattern('^development-[0-9]{3}$')][string]$BuildName='development-006',
    [string]$SourceReceipt
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace ('build\'+$BuildName)
$dism = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM\dism.exe'
function Dism([string]$Name,[string[]]$Arguments) {
    & $dism /English @Arguments "/LogPath:$build\$Name.log" > (Join-Path $build ($Name+'-output.txt'))
    if ($LASTEXITCODE -ne 0) { throw "File payload finalization failed ($Name, $LASTEXITCODE)." }
}
try {
    $node = Join-Path $workspace 'private\tools\node.exe'
    $env:VOLTERRA_GIT_PATH = Join-Path $workspace 'private\tools\git\cmd\git.exe'
    if (-not $SourceReceipt) {
        $prepared = & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Checked image source preparation failed.' }
        $SourceReceipt = ($prepared | ConvertFrom-Json).receiptFile
    }
    $verified = & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --verify $SourceReceipt
    if ($LASTEXITCODE -ne 0) { throw 'Checked image source verification failed.' }
    $source = $verified | ConvertFrom-Json
    $receipt = Get-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Raw | ConvertFrom-Json
    foreach ($kind in @('boot','install')) {
        $wim = Join-Path $build "output\$kind.wim"
        if ((Get-FileHash -LiteralPath $wim).Hash -ne $receipt.($kind+'SHA256')) { throw 'Serviced image hash changed.' }
        $mount = Join-Path $build ('final-'+$kind)
        if (Test-Path -LiteralPath $mount) { throw 'An existing finalization mount will not be reused.' }
        New-Item -ItemType Directory -Path $mount | Out-Null
        Dism ('final-mount-'+$kind) @('/Mount-Image',"/ImageFile:$wim",'/Index:1',"/MountDir:$mount")
        $copied = & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --copy $SourceReceipt $mount
        if ($LASTEXITCODE -ne 0 -or ($copied | ConvertFrom-Json).commit -ne $source.commit) { throw 'The offline payload does not match its checked source commit.' }
        Dism ('final-commit-'+$kind) @('/Unmount-Image',"/MountDir:$mount",'/Commit','/CheckIntegrity')
        $receipt.($kind+'SHA256') = (Get-FileHash -LiteralPath $wim).Hash
    }
    $receipt | Add-Member -NotePropertyName helperBuild -NotePropertyValue $BuildName -Force
    $receipt | Add-Member -NotePropertyName sourceCommit -NotePropertyValue $source.commit -Force
    $receipt | Add-Member -NotePropertyName sourceFiles -NotePropertyValue $source.files -Force
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Encoding utf8
    @{ status='passed'; fileOverlayOnly=$true; sourceCommit=$source.commit; runtimeAcceptancePending=$true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8
} catch { @{status='failed';error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8; exit 1 }
