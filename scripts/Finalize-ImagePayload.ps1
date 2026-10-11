#Requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace 'build\development-006'
$dism = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM\dism.exe'
function Dism([string]$Name,[string[]]$Arguments) {
    & $dism /English @Arguments "/LogPath:$build\$Name.log" > (Join-Path $build ($Name+'-output.txt'))
    if ($LASTEXITCODE -ne 0) { throw "File payload finalization failed ($Name, $LASTEXITCODE)." }
}
try {
    $receipt = Get-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Raw | ConvertFrom-Json
    foreach ($kind in @('boot','install')) {
        $wim = Join-Path $build "output\$kind.wim"
        if ((Get-FileHash -LiteralPath $wim).Hash -ne $receipt.($kind+'SHA256')) { throw 'Serviced image hash changed.' }
        $mount = Join-Path $build ('final-'+$kind)
        if (Test-Path -LiteralPath $mount) { throw 'An existing finalization mount will not be reused.' }
        New-Item -ItemType Directory -Path $mount | Out-Null
        Dism ('final-mount-'+$kind) @('/Mount-Image',"/ImageFile:$wim",'/Index:1',"/MountDir:$mount")
        $payload = Join-Path $mount 'Volterra'
        & robocopy.exe (Join-Path $workspace 'app') (Join-Path $payload 'app') /E /COPY:DAT /R:1 /W:1 /XJ /NP "/LOG:$build\final-copy-$kind.log" | Out-Null
        if ($LASTEXITCODE -gt 7) { throw 'App copy failed.' }
        Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object Extension -in @('.ps1','.mjs','.cmd') | Copy-Item -Destination (Join-Path $payload 'scripts') -Force
        foreach ($file in @('PROJECT_BRIEF.md','AGENTS.md','README.md')) { Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $payload -Force }
        Copy-Item -LiteralPath (Join-Path $workspace 'PROJECT_BRIEF.md') -Destination (Join-Path $mount 'PROJECT_BRIEF.md') -Force
        [IO.File]::WriteAllText((Join-Path $mount 'AGENTS.md'), "This is the Microsoft Volterra development OS root. Read Volterra/AGENTS.md and Volterra/PROJECT_BRIEF.md before changing source. Application and approved design paths are relative to Volterra. Keep credentials and third-party OS binaries out of GitHub. Do not restart automatically.`r`n",[Text.UTF8Encoding]::new($false))
        Dism ('final-commit-'+$kind) @('/Unmount-Image',"/MountDir:$mount",'/Commit','/CheckIntegrity')
        $receipt.($kind+'SHA256') = (Get-FileHash -LiteralPath $wim).Hash
    }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Encoding utf8
    @{ status='passed'; fileOverlayOnly=$true; runtimeAcceptancePending=$true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8
} catch { @{status='failed';error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8; exit 1 }
