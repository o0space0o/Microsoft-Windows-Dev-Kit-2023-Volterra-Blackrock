[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceReceipt)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools=Join-Path $workspace 'private\tools'
function Guard([string]$Path) {
    $absolute=[IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($workspace+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'The facts build path must stay inside this workspace.' }
    $current=$absolute
    while ($current -and $current.Length -ge $workspace.Length) {
        $item=Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType)) { throw 'A facts build path is linked.' }
        if ($current -eq $workspace) { break }; $current=Split-Path -Parent $current
    }
    return $absolute
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
$SourceReceipt=Guard $SourceReceipt
$node=Guard (Join-Path $tools 'node.exe')
$verified=& $node (Join-Path $workspace 'scripts\Prepare-ImageSource.mjs') --verify $SourceReceipt
if ($LASTEXITCODE -ne 0) { throw 'The immutable source receipt could not be verified.' }
$checked=$verified | ConvertFrom-Json
if ($checked.checksPassed -ne $true -or $checked.commit -notmatch '^[a-f0-9]{40}$') { throw 'The facts build requires an actually checked source commit.' }
$source=Guard (Join-Path $checked.source 'scripts\Probe-WindowsFacts.cs')
$buildScript=Guard $PSCommandPath
$sourceHash=Hash $source
$scriptHash=Hash $buildScript
if ($sourceHash -ne $checked.files.'scripts/Probe-WindowsFacts.cs' -or $scriptHash -ne $checked.files.'scripts/Build-WindowsFacts.ps1') { throw 'The facts source or build script differs from the checked snapshot.' }
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\FrameworkArm64\v4.0.30319\csc.exe'
$management=Join-Path (Split-Path $compiler) 'System.Management.dll'
$systemAssembly=Join-Path (Split-Path $compiler) 'System.dll'
$coreAssembly=Join-Path (Split-Path $compiler) 'mscorlib.dll'
foreach ($dependency in @($compiler,$management,$systemAssembly,$coreAssembly)) {
    $item=Get-Item -LiteralPath $dependency -Force
    # Windows component files use ordinary NTFS hardlinks. Only these fixed,
    # read-only signed framework leaves permit them; source and output do not.
    if (-not ($item -is [IO.FileInfo]) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($item.LinkType -and $item.LinkType -ne 'HardLink')) { throw 'The local framework build dependency is redirected.' }
    $parent=Split-Path -Parent $dependency
    while ($parent) {
        $directory=Get-Item -LiteralPath $parent -Force
        if (-not ($directory -is [IO.DirectoryInfo]) -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $directory.LinkType) { throw 'A framework build ancestor is redirected.' }
        $next=Split-Path -Parent $parent; if ($next -eq $parent) { break }; $parent=$next
    }
    if ((Get-AuthenticodeSignature -LiteralPath $dependency).Status -ne 'Valid') { throw 'The local Microsoft build dependency signature is invalid.' }
}
$compilerHash=Hash $compiler; $managementHash=Hash $management; $systemHash=Hash $systemAssembly; $coreHash=Hash $coreAssembly
$target=Guard (Join-Path $tools 'volterra-facts.exe')
$manifest=Guard (Join-Path $tools 'volterra-facts-build.json')
foreach ($file in @($target,$manifest)) { if (Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue) { throw 'Existing facts build output will not be overwritten.' } }
$temporary=Guard (Join-Path $tools ('volterra-facts-'+[Guid]::NewGuid().ToString('N')+'.exe'))
$log=Guard (Join-Path $workspace ('build\verification\facts-compile-'+[Guid]::NewGuid().ToString('N')+'.txt'))
$sourceLock=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    & $compiler /nologo /noconfig /target:exe /platform:anycpu /optimize+ "/reference:$management" "/reference:$systemAssembly" "/out:$temporary" $source > $log 2>&1
    if ($LASTEXITCODE -ne 0) { throw "The original facts helper did not compile. See $log" }
} finally { $sourceLock.Dispose() }
$temporary=Guard $temporary
if ((Hash $source) -ne $sourceHash -or (Hash $buildScript) -ne $scriptHash -or (Hash $compiler) -ne $compilerHash -or (Hash $management) -ne $managementHash -or (Hash $systemAssembly) -ne $systemHash -or (Hash $coreAssembly) -ne $coreHash) { throw 'A facts build input changed during compilation.' }
$toolHash=Hash $temporary
$bytes=(Get-Item -LiteralPath $temporary).Length
if ($bytes -lt 1024 -or $bytes -gt 1048576) { throw 'The original facts executable size was unsupported.' }
$proof=@{version=1;kind='volterraWindowsFactsBuild';sourceCommit=$checked.commit;sourceFile='scripts/Probe-WindowsFacts.cs';sourceSHA256=$sourceHash;buildScript='scripts/Build-WindowsFacts.ps1';buildScriptSHA256=$scriptHash;executable=@{file='private/tools/volterra-facts.exe';SHA256=$toolHash;bytes=$bytes;target='AnyCPU; ARM64 Windows CLR required'};compiler=@{path=$compiler;SHA256=$compilerHash;fileVersion=(Get-Item -LiteralPath $compiler).VersionInfo.FileVersion};managementAssembly=@{path=$management;SHA256=$managementHash;fileVersion=(Get-Item -LiteralPath $management).VersionInfo.FileVersion};systemAssembly=@{path=$systemAssembly;SHA256=$systemHash;fileVersion=(Get-Item -LiteralPath $systemAssembly).VersionInfo.FileVersion};coreAssembly=@{path=$coreAssembly;SHA256=$coreHash;fileVersion=(Get-Item -LiteralPath $coreAssembly).VersionInfo.FileVersion};guestCompatibilityVerified=$false;compiledAt=[DateTime]::UtcNow.ToString('o');compileLog=$log}
Guard $target | Out-Null; Guard $manifest | Out-Null
[IO.File]::Move($temporary,$target)
$writer=[IO.File]::Open($manifest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $content=[Text.UTF8Encoding]::new($false).GetBytes(($proof | ConvertTo-Json -Depth 8)); $writer.Write($content,0,$content.Length) } finally { $writer.Dispose() }
if ((Hash (Guard $target)) -ne $toolHash) { throw 'The compiled facts output changed.' }
$proof | ConvertTo-Json -Depth 8
