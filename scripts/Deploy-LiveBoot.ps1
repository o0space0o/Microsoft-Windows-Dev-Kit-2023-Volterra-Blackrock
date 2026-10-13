#Requires -RunAsAdministrator
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$ImageReceipt,
 [Parameter(Mandatory)][string]$ExpectedDiskUniqueId,
 [Parameter(Mandatory)][guid]$ExpectedPartitionGuid,
 [Parameter(Mandatory)][guid]$WindowsDefaultId
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$recovery=Join-Path $workspace 'private\recovery\live-boot';$receipt=Join-Path $recovery 'deployment.json'
$loader='{'+[guid]::NewGuid().ToString()+'}';$ramdisk='{'+[guid]::NewGuid().ToString()+'}'
$created=@();$ownedRecovery=$false;$ownedImageMount=$false;$result=[ordered]@{kind='volterraLiveBootDeployment';status='checking';target='A:\';loader=$loader;ramdiskOptions=$ramdisk;formatted=$false;windowsDefaultChanged=$false;hostRestarted=$false;physicalBootVerified=$false}
function Ordinary([string]$target){
 $resolved=(Resolve-Path -LiteralPath $target).Path
 for($cursor=$resolved;$cursor;$cursor=Split-Path $cursor){if((Get-Item -LiteralPath $cursor -Force).Attributes-band[IO.FileAttributes]::ReparsePoint){throw 'A deployment path is redirected'};if($cursor-eq[IO.Path]::GetPathRoot($cursor)){break}}
 return $resolved
}
function Bcd([string[]]$arguments){$output=& "$env:SystemRoot\System32\bcdedit.exe" @arguments 2>&1;if($LASTEXITCODE-ne0){throw ('Boot configuration operation failed: '+($output-join' '))};return $output-join"`n"}
function CheckTarget{
 $partition=Get-Partition -DriveLetter A;$disk=$partition|Get-Disk;$volume=$partition|Get-Volume
 if($disk.UniqueId-cne$ExpectedDiskUniqueId-or[guid]$partition.Guid-ne$ExpectedPartitionGuid-or$partition.IsBoot-or$partition.IsSystem-or$volume.FileSystem-cne'NTFS'-or$volume.HealthStatus-ne'Healthy'){throw 'A: does not match the authorized data partition'}
 $bitlocker=Get-BitLockerVolume -MountPoint 'A:'
 if($bitlocker.LockStatus-ne'Unlocked'-or$bitlocker.EncryptionPercentage-ne0){throw 'A: must be unlocked and decrypted for this live boot'}
 $default='{'+$WindowsDefaultId.ToString()+'}'
 $manager=Bcd @('/enum','{bootmgr}','/v')
 if($manager-notmatch('(?m)^default\s+'+[regex]::Escape($default)+'\s*$')){throw 'The Windows default boot entry differs'}
 return $manager
}
try{
 $image=Get-Content -LiteralPath (Ordinary $ImageReceipt) -Raw|ConvertFrom-Json
 $canonical=Join-Path $workspace 'build\current\Microsoft Volterra.iso'
 $looseMedia=Join-Path $workspace 'build\current\Media';$wim=Join-Path $looseMedia 'Sources\boot.wim'
 if($image.kind-cne'volterraCurrentLiveImage'-or$image.iso-cne$canonical-or$image.wim-cne$wim-or$image.vmBootVerified-ne$true-or$image.credentialsIncluded-ne$false){throw 'The single current live image lacks bound VM boot evidence'}
 if((Get-FileHash -LiteralPath (Ordinary $canonical)).Hash-cne$image.isoSHA256-or(Get-FileHash -LiteralPath (Ordinary $wim)).Hash-cne$image.wimSHA256){throw 'The verified live image changed'}
 $before=CheckTarget
 if(Test-Path -LiteralPath $recovery){throw 'A previous deployment record exists; inspect it before continuing'}
 if(@(Get-ChildItem -LiteralPath 'A:\' -Force|Where-Object Name -NotIn @('$RECYCLE.BIN','System Volume Information')).Count){throw 'A: contains unexpected data; no files were replaced'}
 if((Bcd @('/enum','all','/v'))-match'(?m)^description\s+Microsoft Volterra\s*$'){throw 'An existing Volterra boot entry needs inspection'}
 New-Item -ItemType Directory -Path $recovery|Out-Null;Ordinary $recovery|Out-Null;$ownedRecovery=$true
 $backup=Join-Path $recovery 'BCD.before';Bcd @('/export',$backup)|Out-Null
 $result.backupSHA256=(Get-FileHash -LiteralPath $backup).Hash;$result.sourceCommit=$image.sourceCommit;$result.isoSHA256=$image.isoSHA256;$result.wimSHA256=$image.wimSHA256
 $before|Set-Content -LiteralPath (Join-Path $recovery 'boot-manager.before.txt') -Encoding utf8
 # Bind every support file to the hash-verified, read-only ISO. Loose build
 # files can change after creation and cannot establish deployment integrity.
 $diskImage=Get-DiskImage -ImagePath $canonical
 if(-not$diskImage.Attached){$diskImage=Mount-DiskImage -ImagePath $canonical -StorageType ISO -Access ReadOnly -PassThru;$ownedImageMount=$true}
 $isoVolumes=@($diskImage|Get-Volume)
 if($isoVolumes.Count-ne1-or[char]$isoVolumes[0].DriveLetter-notmatch'^[B-Z]$'-or$isoVolumes[0].FileSystem-notin@('CDFS','UDF')){throw 'The verified ISO mount is not a single optical volume'}
 $media=([string]$isoVolumes[0].DriveLetter)+':\'
 $sealedWim=Ordinary (Join-Path $media 'Sources\boot.wim')
 if((Get-FileHash -LiteralPath $sealedWim).Hash-cne$image.wimSHA256){throw 'The ISO boot image differs from its sealed WIM'}
 foreach($name in @('Boot','EFI','bootmgr.efi','Validation OS license.rtf')){
  $inputPath=Ordinary (Join-Path $media $name)
  if((Get-Item -LiteralPath $inputPath).PSIsContainer){foreach($entry in Get-ChildItem -LiteralPath $inputPath -Force -Recurse){Ordinary $entry.FullName|Out-Null}}
  Copy-Item -LiteralPath $inputPath -Destination 'A:\' -Recurse
 }
 New-Item -ItemType Directory -Path 'A:\Sources'|Out-Null
 Copy-Item -LiteralPath $sealedWim -Destination 'A:\Sources\boot.wim'
 $result.mediaFiles=@()
 foreach($file in Get-ChildItem -LiteralPath $media -Force -Recurse -File){
  $relative=$file.FullName.Substring($media.Length).TrimStart('\');$destination=Join-Path 'A:\' $relative;$expectedHash=(Get-FileHash -LiteralPath $file.FullName).Hash
  if((Get-FileHash -LiteralPath (Ordinary $destination)).Hash-cne$expectedHash){throw 'Live boot file readback differs'}
  $result.mediaFiles+=@{file=$relative;SHA256=$expectedHash}
 }
 if((Get-FileHash -LiteralPath (Ordinary $canonical)).Hash-cne$image.isoSHA256){throw 'The ISO changed during deployment'}
 [IO.File]::WriteAllText('A:\Volterra-persistent.tag','Microsoft Volterra persistent workspace',[Text.Encoding]::ASCII)
 CheckTarget|Out-Null
 Bcd @('/create',$ramdisk,'/d','Microsoft Volterra live image','/device')|Out-Null;$created+=$ramdisk
 Bcd @('/set',$ramdisk,'ramdisksdidevice','partition=A:')|Out-Null
 Bcd @('/set',$ramdisk,'ramdisksdipath','\Boot\boot.sdi')|Out-Null
 Bcd @('/create',$loader,'/d','Microsoft Volterra','/application','osloader')|Out-Null;$created+=$loader
 $device='ramdisk=[A:]\Sources\boot.wim,'+$ramdisk
 foreach($setting in @(@('device',$device),@('osdevice',$device),@('path','\Windows\System32\Boot\winload.efi'),@('systemroot','\Windows'),@('winpe','Yes'),@('detecthal','Yes'),@('inherit','{bootloadersettings}'))){Bcd (@('/set',$loader)+$setting)|Out-Null}
 $entry=Bcd @('/enum',$loader,'/v');$options=Bcd @('/enum',$ramdisk,'/v')
 if($entry-notmatch[regex]::Escape($device)-or$entry-notmatch'(?m)^description\s+Microsoft Volterra\s*$'-or$options-notmatch'ramdisksdipath\s+\\Boot\\boot.sdi'){throw 'Live boot entry readback differs'}
 Bcd @('/displayorder',$loader,'/addlast')|Out-Null
 CheckTarget|Set-Content -LiteralPath (Join-Path $recovery 'boot-manager.after.txt') -Encoding utf8
 $entry|Set-Content -LiteralPath (Join-Path $recovery 'volterra-entry.txt') -Encoding utf8
 $options|Set-Content -LiteralPath (Join-Path $recovery 'volterra-device.txt') -Encoding utf8
 $result.status='Live boot files and Microsoft Volterra entry prepared; physical boot pending'
}catch{
 $result.status='failed';$result.error=$_.ToString();$result.line=$_.InvocationInfo.ScriptLineNumber
 foreach($id in $created){try{Bcd @('/delete',$id,'/cleanup')|Out-Null}catch{$result.rollbackError=$_.ToString()}}
}finally{
 if($ownedImageMount){Dismount-DiskImage -ImagePath $canonical|Out-Null}
 $result.utc=[DateTime]::UtcNow.ToString('o')
 if($ownedRecovery){Ordinary $recovery|Out-Null;$result|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $receipt -Encoding utf8}
}
$result|ConvertTo-Json -Depth 6
if($result.status-eq'failed'){exit 1}
