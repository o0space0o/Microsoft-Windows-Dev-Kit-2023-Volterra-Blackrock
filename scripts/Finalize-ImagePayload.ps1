#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidatePattern('^development-[0-9]{3}$')][string]$BuildName='development-006')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace ('build\'+$BuildName)
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
        foreach ($folder in @('test','image')) {
            & robocopy.exe (Join-Path $workspace $folder) (Join-Path $payload $folder) /E /COPY:DAT /R:1 /W:1 /XJ /NP "/LOG:$build\final-copy-$kind-$folder.log" | Out-Null
            if ($LASTEXITCODE -gt 7) { throw 'Source test or startup payload copy failed.' }
        }
        foreach ($file in @('package.json','automation.json','.gitignore')) { Copy-Item -LiteralPath (Join-Path $workspace $file) -Destination $payload -Force }
        $bootstrap = Join-Path $payload 'private\bootstrap'
        New-Item -ItemType Directory -Path $bootstrap -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Apply-SourceUpdate.mjs') -Destination $bootstrap -Force
        $git = Join-Path $workspace 'private\tools\git\cmd\git.exe'
        $sourceCommit = & $git -C $workspace rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Source commit receipt could not be generated.' }
        @{ repository='o0space0o/Microsoft-Windows-Dev-Kit-2023-Volterra-Blackrock'; commit=$sourceCommit } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $payload 'private\source-version.json') -Encoding utf8
        Copy-Item -LiteralPath (Join-Path $workspace 'image\Volterra-Startup.cmd') -Destination (Join-Path $mount 'Windows\VolterraStartup.cmd') -Force
        Copy-Item -LiteralPath (Join-Path $workspace 'PROJECT_BRIEF.md') -Destination (Join-Path $mount 'PROJECT_BRIEF.md') -Force
        [IO.File]::WriteAllText((Join-Path $mount 'AGENTS.md'), "This is the Microsoft Volterra development OS root. Read Volterra/AGENTS.md and Volterra/PROJECT_BRIEF.md before changing source. Application and approved design paths are relative to Volterra. Keep credentials and third-party OS binaries out of GitHub. Do not restart automatically.`r`n",[Text.UTF8Encoding]::new($false))
        Dism ('final-commit-'+$kind) @('/Unmount-Image',"/MountDir:$mount",'/Commit','/CheckIntegrity')
        $receipt.($kind+'SHA256') = (Get-FileHash -LiteralPath $wim).Hash
    }
    $receipt | Add-Member -NotePropertyName helperBuild -NotePropertyValue $BuildName -Force
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Encoding utf8
    @{ status='passed'; fileOverlayOnly=$true; runtimeAcceptancePending=$true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8
} catch { @{status='failed';error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8; exit 1 }
