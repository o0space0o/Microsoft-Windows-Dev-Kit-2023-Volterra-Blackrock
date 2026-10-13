[CmdletBinding()]
param([string]$ToolchainRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $ToolchainRoot){$ToolchainRoot=Join-Path (Split-Path $workspace -Parent) 'CustomWindowsDevKit\private\Toolchain'}
$ToolchainRoot=[IO.Path]::GetFullPath($ToolchainRoot)
$toolchainName='llvm-mingw-20260922-ucrt-aarch64'
$archiveName=$toolchainName+'.zip'
$archiveSHA256='A317514A7A63BADD692032C0C2B8E165F630BBAEBBE7A3254348051F43A64949'
$output=Join-Path $workspace 'private\rebase-tools'
$source=Join-Path $PSScriptRoot 'Launch-Volterra.cpp'
$target=Join-Path $output 'DesktopShell.exe'
$receipt=Join-Path $output 'launcher-build.json'
$log=Join-Path $output 'launcher-compile.log'
$checkedParents=@{}
function Ordinary([string]$Path) {
 $absolute=[IO.Path]::GetFullPath($Path)
 for($cursor=$absolute;$cursor;){
  if($cursor-ne$absolute-and$checkedParents.ContainsKey($cursor)){break}
  $item=Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
  if($item-and(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.LinkType)){throw "A launcher build path is redirected: $cursor"}
  if($item-and$item.PSIsContainer){$checkedParents[$cursor]=$true}
  $parent=Split-Path -Parent $cursor
  if(-not$parent-or$parent-eq$cursor){break};$cursor=$parent
 }
 return $absolute
}
function Hash([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash}
Ordinary $workspace|Out-Null; Ordinary $ToolchainRoot|Out-Null
$record=Get-Content -Raw -LiteralPath (Ordinary (Join-Path $ToolchainRoot 'source.json'))|ConvertFrom-Json
if($record.name-cne$archiveName-or$record.digest-cne('sha256:'+$archiveSHA256.ToLowerInvariant())){throw 'The toolchain source record does not match the reviewed ARM64 compiler archive'}
$archive=Ordinary (Join-Path $ToolchainRoot $archiveName)
if((Hash $archive)-cne$archiveSHA256){throw 'The reviewed compiler archive hash differs'}
$toolchain=Ordinary (Join-Path $ToolchainRoot $toolchainName)
$compiler=Ordinary (Join-Path $toolchain 'bin\aarch64-w64-mingw32-clang++.exe')
# Bind the extracted compiler, headers and libraries to the retained verified
# archive. This is a read-only comparison, not extraction or toolchain repair.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
$algorithm=[Security.Cryptography.SHA256]::Create()
$verifiedFiles=0
try {
 foreach($entry in $zip.Entries){
  if($entry.FullName.EndsWith('/')){continue}
  if(-not$entry.FullName.StartsWith($toolchainName+'/',[StringComparison]::Ordinal)){throw 'A compiler archive entry escapes the reviewed toolchain'}
  $relative=$entry.FullName.Substring($toolchainName.Length+1).Replace('/','\')
  $file=[IO.Path]::GetFullPath((Join-Path $toolchain $relative))
  if(-not$file.StartsWith($toolchain+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'A compiler archive entry escapes the toolchain directory'}
  Ordinary $file|Out-Null
  if((Get-Item -LiteralPath $file).Length-ne$entry.Length){throw "An extracted toolchain file differs: $relative"}
  $stream=$entry.Open()
  try{$expected=[BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','')}finally{$stream.Dispose()}
  if((Hash $file)-cne$expected){throw "An extracted toolchain file differs: $relative"}
  $verifiedFiles++
 }
}finally{$algorithm.Dispose();$zip.Dispose()}
if($verifiedFiles-lt1){throw 'The compiler archive contains no verified files'}
Ordinary $source|Out-Null;Ordinary $output|Out-Null
foreach($file in @($target,$receipt,$log)){if(Test-Path -LiteralPath $file){throw 'Existing launcher build output will not be overwritten'}}
$sourceSHA=Hash $source;$scriptSHA=Hash $PSCommandPath;$compilerSHA=Hash $compiler
if(-not(Test-Path -LiteralPath $output)){New-Item -ItemType Directory -Path $output|Out-Null}
Ordinary $output|Out-Null
$arguments=@('-std=c++17','-O2','-static','-municode','-mconsole','-Wall','-Wextra','-Werror',$source,'-o',$target,'-ladvapi32','-luser32')
$sourceLock=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try{& $compiler @arguments *> $log;$compileExit=$LASTEXITCODE}finally{$sourceLock.Dispose()}
if($compileExit-ne0){throw "The native launcher did not compile; see $log"}
if((Hash $source)-cne$sourceSHA-or(Hash $PSCommandPath)-cne$scriptSHA-or(Hash $compiler)-cne$compilerSHA){throw 'A launcher build input changed during compilation'}
Ordinary $target|Out-Null
$bytes=[IO.File]::ReadAllBytes($target)
if($bytes.Length-lt1024-or$bytes.Length-gt2097152){throw 'The launcher executable has an unexpected size'}
$peOffset=[BitConverter]::ToInt32($bytes,0x3c)
if($peOffset-lt0-or$peOffset+24-ge$bytes.Length-or[BitConverter]::ToUInt32($bytes,$peOffset)-ne0x4550-or[BitConverter]::ToUInt16($bytes,$peOffset+4)-ne0xaa64){throw 'The launcher is not an ARM64 PE executable'}
$proof=[ordered]@{version=1;kind='volterraNativeLauncherBuild';source='scripts/Launch-Volterra.cpp';sourceSHA256=$sourceSHA;buildScriptSHA256=$scriptSHA;toolchainArchiveSHA256=$archiveSHA256;toolchainVerifiedFiles=$verifiedFiles;compilerSHA256=$compilerSHA;executable='private/rebase-tools/DesktopShell.exe';executableSHA256=(Hash $target);executableBytes=$bytes.Length;architecture='arm64';subsystem='console';compiledAtUtc=[DateTime]::UtcNow.ToString('o');guestCompatibilityVerified=$false;hostBootChanged=$false}
$json=$proof|ConvertTo-Json -Depth 4
$writer=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$content=[Text.UTF8Encoding]::new($false).GetBytes($json);$writer.Write($content,0,$content.Length)}finally{$writer.Dispose()}
$json
