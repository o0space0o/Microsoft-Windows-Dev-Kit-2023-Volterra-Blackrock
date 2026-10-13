#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$SourceReceipt,
 [Parameter(Mandatory)][string]$BaseBootWim,
 [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$BaseSHA256,
 [Parameter(Mandatory)][string]$BaseMedia,
 [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$PreviousSeedSHA256
)
$ErrorActionPreference='Stop'; Import-Module Dism
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$current=Join-Path $workspace 'build\current'; $mount=Join-Path $current 'final-boot'
$media=Join-Path $current 'Media'; $wim=Join-Path $media 'Sources\boot.wim'
$iso=Join-Path $current 'Microsoft Windows Dev Kit 2023 Volterra Blackrock.iso'
$node=Join-Path $workspace 'private\tools\node.exe'
$env:VOLTERRA_GIT_PATH=Join-Path $workspace 'private\tools\git\cmd\git.exe'
$mounted=$false; $ownedOutput=$false
$result=[ordered]@{version=1;kind='volterraCurrentLiveImage';status='checking';physicalDisksWritten=$false;hostBootChanged=$false;credentialsIncluded=$false;bootAccepted=$false;runtimeAccepted=$false;physicalHardwareAccepted=$false;publicDistributionAllowed=$false}
function Progress([string]$message){[IO.File]::WriteAllText((Join-Path $current 'progress.txt'),$message)}
function Ordinary([string]$target){
 $resolved=(Resolve-Path -LiteralPath $target).Path
 # WIM-backed files can carry provider reparse attributes without being links.
 # The owned JS guard checks real paths, entry types and link counts instead.
 if($mounted-and($resolved-eq$mount-or$resolved.StartsWith($mount+'\',[StringComparison]::OrdinalIgnoreCase))){
  $module=([uri](Join-Path $PSScriptRoot 'Start-Volterra.mjs')).AbsoluteUri
  & $node --input-type=module -e "import fs from 'node:fs/promises';const m=await import(process.argv[1]);const p=process.argv[2];await m.ownedPath(p,(await fs.lstat(p)).isDirectory()?'directory':'file');" $module $resolved
  if($LASTEXITCODE-ne0){throw ('An image path is redirected or not ordinary: '+$resolved)}
  return $resolved
 }
 for($cursor=$resolved;$cursor;$cursor=Split-Path $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'A build path is redirected'};if($cursor-eq[IO.Path]::GetPathRoot($cursor)){break}}
 return $resolved
}
try{
 if(@(Get-WindowsImage -Mounted).Count){throw 'Another offline image is mounted'}
 Ordinary $workspace|Out-Null
 $buildRoot=Join-Path $workspace 'build'
 if(-not(Test-Path -LiteralPath $buildRoot)){New-Item -ItemType Directory -Path $buildRoot|Out-Null}
 Ordinary $buildRoot|Out-Null
 $base=Ordinary $BaseBootWim; $baseMedia=Ordinary $BaseMedia; $SourceReceipt=Ordinary $SourceReceipt
 if((Get-FileHash -LiteralPath $base).Hash-cne$BaseSHA256.ToUpperInvariant()){throw 'Sealed base image differs'}
 if(Test-Path -LiteralPath $current){throw 'Current output already exists; preserve it until a replacement is verified'}
 New-Item -ItemType Directory -Path $current,$mount,(Split-Path $wim)|Out-Null
 Ordinary $current|Out-Null; $ownedOutput=$true
 Progress 'Verifying published source'
 & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --verify $SourceReceipt > (Join-Path $current 'source-verification.json') 2> (Join-Path $current 'source-verification-error.txt')
 if($LASTEXITCODE-ne0){throw 'Published source verification failed'}
 $source=Get-Content -LiteralPath $SourceReceipt -Raw|ConvertFrom-Json
 Copy-Item -LiteralPath $SourceReceipt -Destination (Join-Path $current 'source-receipt.json')
 Progress 'Refreshing the single live RAM image'; Copy-Item -LiteralPath $base -Destination $wim
 Mount-WindowsImage -ImagePath $wim -Index 1 -Path $mount|Out-Null; $mounted=$true
 & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --copy $SourceReceipt $mount > (Join-Path $current 'source-overlay.json') 2> (Join-Path $current 'source-overlay-error.txt')
 if($LASTEXITCODE-ne0){throw 'Checked source overlay failed'}
 & $node (Join-Path $PSScriptRoot 'Stage-WindowsFacts.mjs') $SourceReceipt $workspace $mount verify > (Join-Path $current 'native-verification.json') 2> (Join-Path $current 'native-verification-error.txt')
 if($LASTEXITCODE-ne0){throw 'Source-bound native runtime verification failed'}
 $application=Join-Path $mount 'Volterra'; $seed=Ordinary (Join-Path $application 'private\live-seed.json')
 if((Get-FileHash -LiteralPath $seed).Hash-cne$PreviousSeedSHA256.ToUpperInvariant()){throw 'Previous live seed differs'}
 Remove-Item -LiteralPath $seed
 $metrics=Join-Path $application 'private\tools\chrome\SetupMetrics'
 if(Test-Path -LiteralPath $metrics){
  $resolved=Ordinary $metrics
  if($resolved-cne[IO.Path]::GetFullPath($metrics)-or-not$resolved.StartsWith($mount+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Temporary metrics escaped the image'}
  foreach($entry in Get-ChildItem -LiteralPath $resolved -Force -Recurse){Ordinary $entry.FullName|Out-Null}
  Remove-Item -LiteralPath $resolved -Recurse -Force
 }
 Progress 'Sealing credential-free persistent workspace'
 & $node (Join-Path $PSScriptRoot 'Seal-LiveSeed.mjs') $mount $source.commit > (Join-Path $current 'seed-receipt.json') 2> (Join-Path $current 'seed-error.txt')
 if($LASTEXITCODE-ne0){throw 'Live workspace sealing failed'}
 Progress 'Committing the live boot image'; Dismount-WindowsImage -Path $mount -Save -CheckIntegrity|Out-Null; $mounted=$false
 foreach($name in @('boot','efi','bootmgr.efi','Validation OS license.rtf')){
  $inputPath=Ordinary (Join-Path $baseMedia $name)
  if((Get-Item -LiteralPath $inputPath).PSIsContainer){foreach($entry in Get-ChildItem -LiteralPath $inputPath -Force -Recurse){Ordinary $entry.FullName|Out-Null}}
  Copy-Item -LiteralPath $inputPath -Destination $media -Recurse
 }
 $tool='C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\Oscdimg\oscdimg.exe'
 $efi=Join-Path (Split-Path $tool) 'efisys_noprompt.bin'
 Progress 'Creating Microsoft Volterra live ISO'
 & $tool -m -o -u2 -udfver102 -lBLACKROCK "-bootdata:1#pEF,e,b$efi" $media $iso *> (Join-Path $current 'iso.log')
 if($LASTEXITCODE-ne0){throw 'Live ISO creation failed'}
 $result.status='created; boot verification pending';$result.sourceCommit=$source.commit;$result.wim=$wim;$result.wimSHA256=(Get-FileHash -LiteralPath $wim).Hash;$result.iso=$iso;$result.isoSHA256=(Get-FileHash -LiteralPath $iso).Hash;$result.isoBytes=(Get-Item -LiteralPath $iso).Length
 Progress $result.status
}catch{$result.status='failed';$result.error=$_.ToString();$result.line=$_.InvocationInfo.ScriptLineNumber}
finally{if($mounted){Dismount-WindowsImage -Path $mount -Discard|Out-Null};if($ownedOutput){Ordinary $current|Out-Null;$result.utc=[DateTime]::UtcNow.ToString('o');$result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $current 'image-receipt.json') -Encoding utf8}}
if($result.status-ne'created; boot verification pending'){exit 1}
