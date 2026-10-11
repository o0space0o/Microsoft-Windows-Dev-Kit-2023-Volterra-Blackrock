#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$BuildDirectory, [string]$SourceDrive = 'D:')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = [IO.Path]::GetFullPath($BuildDirectory)
$allowed = Join-Path $workspace 'build\'
if (-not $build.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build output must be inside the workspace build directory.' }
if (Test-Path -LiteralPath $build) { throw 'Use a fresh build directory. Existing builds will not be overwritten.' }
New-Item -ItemType Directory -Path $build | Out-Null
$alias = Join-Path $env:LOCALAPPDATA ('VolterraBuild-' + [Guid]::NewGuid().ToString('N'))
if ($alias -match '[\s&|<>^!]') { throw 'The temporary build alias must have a plain path without spaces or shell metacharacters.' }
New-Item -ItemType Junction -Path $alias -Target $build | Out-Null
@{ alias = $alias; target = $build } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'path-alias.json') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $workspace 'image\Volterra-Startup.cmd') -Destination (Join-Path $alias 'Volterra-Startup.cmd')
$dismFolder = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM'
$env:PATH = "$dismFolder;$env:PATH"
function Status([string]$phase, [string]$errorText = '') {
    @{ phase = $phase; error = $errorText; time = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $build 'status.json') -Encoding utf8
}
try {
    if (-not (Test-Path -LiteralPath "$SourceDrive\GenImage\GenImage.cmd")) { throw 'The original Validation OS ISO must be mounted.' }
    Status 'Exporting installed device drivers'
    $drivers = Join-Path $build 'drivers'
    New-Item -ItemType Directory -Path $drivers | Out-Null
    & "$env:SystemRoot\System32\pnputil.exe" /export-driver '*' $drivers 2>&1 |
        Set-Content -LiteralPath (Join-Path $build 'driver-export.log') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Driver export failed ($LASTEXITCODE)." }
    Get-WindowsDriver -Online | Select-Object Driver, OriginalFileName, ProviderName, ClassName, Version, Date |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $build 'driver-inventory.json') -Encoding utf8
    $packages = New-Object 'System.Collections.Generic.HashSet[string]'
    function Resolve-Feature([string]$File) {
        foreach ($line in (Get-Content -LiteralPath $File)) {
            $entry = $line.Trim()
            if (-not $entry -or $entry.StartsWith('#')) { continue }
            if ($entry.StartsWith('+include ')) { Resolve-Feature (Join-Path (Split-Path $File) $entry.Substring(9).Trim()) }
            else { [void]$packages.Add($entry) }
        }
    }
    foreach ($feature in @('WebviewDependency','hyper-v','InboxDrivers','audio','bluetooth','FileSystems','SMB')) {
        Resolve-Feature "$SourceDrive\GenImage\Configs\Common\$feature.pkg"
    }
    $features = Join-Path $alias 'features.pkg'
    $packages | Sort-Object | Set-Content -LiteralPath $features -Encoding ascii
    foreach ($kind in @('boot', 'install')) {
        Status "Composing $kind image with device drivers and runtime packages"
        $output = Join-Path $alias $kind
        New-Item -ItemType Directory -Path $output | Out-Null
        $mount = Join-Path $output 'mount'
        $bootArgument = if ($kind -eq 'boot') { ' -x' } else { '' }
        # Only fresh, verified build paths are passed to the Microsoft image builder.
        $command = 'call {0}\GenImage\GenImage.cmd -ImagePath:{0}\ -OutPath:{1} -MountDir:{2} -Drivers:{3} -PackagesList:{4} -StartupCommand:{5} -wim -PreventRename -NoWait{6}' -f $SourceDrive, $output, $mount, (Join-Path $alias 'drivers'), $features, (Join-Path $alias 'Volterra-Startup.cmd'), $bootArgument
        $wrapper = Join-Path $output 'run-genimage.cmd'
        "@echo off`r`n$command`r`nexit /b %errorlevel%`r`n" | Set-Content -LiteralPath $wrapper -Encoding ascii
        $imageProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $wrapper) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $output 'genimage.log') -RedirectStandardError (Join-Path $output 'genimage-errors.log')
        if ($imageProcess.ExitCode -ne 0) { throw "Microsoft GenImage failed for $kind ($($imageProcess.ExitCode)). See its logs." }
        $index = if ($kind -eq 'boot') { 2 } else { 1 }
        if (-not (Test-Path -LiteralPath (Join-Path $output "ValidationOS-$index.wim"))) { throw "No optimized $kind image was generated." }
    }
    Status 'Base images composed; application payload and boot verification pending'
} catch { Status 'Failed' $_.Exception.Message; exit 1 }
