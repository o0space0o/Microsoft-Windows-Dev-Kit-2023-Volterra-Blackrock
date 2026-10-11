#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidatePattern('^development-[0-9]{3}$')][string]$BuildName='development-006',
    [string]$PrivateBootSource
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace ('build/'+$BuildName)
$media = Join-Path $build 'iso-media'
$isoName = if ($BuildName -eq 'development-006') { 'Microsoft-Volterra-development-arm64.iso' } else { 'Microsoft-Volterra-'+$BuildName+'-arm64.iso' }
$iso = Join-Path $build $isoName
if (-not $PrivateBootSource) { $PrivateBootSource = Join-Path $workspace 'private/boot-source.json' }
$mountedHere = $false
$started = $false
$sourceLock = $null
$mediaFiles = [Collections.Generic.List[object]]::new()

function Assert-NoReparse([string]$Path, [switch]$AllowMissing) {
    $full = [IO.Path]::GetFullPath($Path)
    $drive = [IO.Path]::GetPathRoot($full)
    $current = $drive
    foreach ($part in $full.Substring($drive.Length).Split([IO.Path]::DirectorySeparatorChar)) {
        if (-not $part) { continue }
        $current = Join-Path $current $part
        try { $currentItem = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
        catch {
            if ($AllowMissing -and $_.Exception -is [Management.Automation.ItemNotFoundException]) { continue }
            throw
        }
        if ($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse paths are not accepted: $current" }
    }
    return $full
}
function Assert-Owned([string]$Path) {
    $full = Assert-NoReparse $Path -AllowMissing
    if ($full -ne $build -and -not $full.StartsWith($build+[IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'An ISO output escaped this build.' }
    return $full
}
function Folder([string]$Path) {
    $full = Assert-Owned $Path
    [IO.Directory]::CreateDirectory($full) | Out-Null
    Assert-NoReparse $full | Out-Null
}
function FileHash([string]$Path) {
    $full = Assert-NoReparse $Path
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer) { throw 'A regular input file is required.' }
    return (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
}
function Require-Hash([string]$Path, [string]$Expected) {
    if ((FileHash $Path) -ne $Expected) { throw "A sealed file hash differs: $Path" }
}
function Copy-One([string]$From, [string]$To, [string]$Expected = '') {
    $fromFull = Assert-NoReparse $From
    $toFull = Assert-Owned $To
    if ((Get-Item -LiteralPath $fromFull -Force).PSIsContainer -or (Test-Path -LiteralPath $toFull)) { throw 'A file copy cannot reuse a destination or copy a nonregular file.' }
    Folder (Split-Path -Parent $toFull)
    $before = FileHash $fromFull
    if ($Expected -and $before -ne $Expected) { throw "An input copy hash differs: $From" }
    $sourceStream = [IO.File]::Open($fromFull, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $destinationStream = [IO.File]::Open($toFull, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $sourceStream.CopyTo($destinationStream); $destinationStream.Flush($true) } finally { $destinationStream.Dispose() }
    } finally { $sourceStream.Dispose() }
    Assert-Owned $toFull | Out-Null
    if ((FileHash $fromFull) -ne $before -or (FileHash $toFull) -ne $before) { throw "A copy changed source bytes: $To" }
    if ($toFull.StartsWith($media+[IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        $mediaFiles.Add(@{ path=$toFull.Substring($media.Length+1).Replace('\','/'); sha256=$before; bytes=(Get-Item -LiteralPath $toFull).Length })
    }
}
function Copy-Tree([string]$From, [string]$To) {
    $fromFull = Assert-NoReparse $From
    if (-not (Get-Item -LiteralPath $fromFull -Force).PSIsContainer) { throw 'A source boot tree is not a directory.' }
    Folder $To
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($fromFull)) {
        Assert-NoReparse $entry | Out-Null
        $target = Join-Path $To ([IO.Path]::GetFileName($entry))
        if ((Get-Item -LiteralPath $entry -Force).PSIsContainer) { Copy-Tree $entry $target } else { Copy-One $entry $target }
    }
}
function Save([string]$Name, $Value) {
    $target = Assert-Owned (Join-Path $build $Name)
    if (Test-Path -LiteralPath $target) { throw 'An ISO receipt will not be overwritten.' }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 15))
    $file = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Assert-Arm64PeBytes([byte[]]$Bytes, [string]$Name) {
    if ($Bytes.Length -lt 64 -or $Bytes[0] -ne 0x4D -or $Bytes[1] -ne 0x5A) { throw "Missing DOS/PE header: $Name" }
    $offset = [BitConverter]::ToUInt32($Bytes,0x3C)
    if ($offset -gt $Bytes.Length-6 -or [BitConverter]::ToUInt32($Bytes,[int]$offset) -ne 0x4550 -or [BitConverter]::ToUInt16($Bytes,[int]$offset+4) -ne 0xAA64) { throw "A required binary is not ARM64 PE: $Name" }
}
function Assert-Arm64Pe([string]$Path) { Assert-Arm64PeBytes ([IO.File]::ReadAllBytes((Assert-NoReparse $Path))) $Path }
function Read-FatChain([byte[]]$Image, [int]$Cluster, [int]$FatOffset, [int]$DataOffset, [int]$ClusterBytes) {
    $stream = [IO.MemoryStream]::new()
    $seen = [Collections.Generic.HashSet[int]]::new()
    try {
        while ($Cluster -lt 0xFF8) {
            if ($Cluster -lt 2 -or $Cluster -eq 0xFF7 -or -not $seen.Add($Cluster) -or $seen.Count -gt 4096) { throw 'Invalid stock FAT12 cluster chain.' }
            $start = $DataOffset+($Cluster-2)*$ClusterBytes
            if ($start -lt 0 -or $start+$ClusterBytes -gt $Image.Length) { throw 'Stock boot image cluster escaped its file.' }
            $stream.Write($Image,$start,$ClusterBytes)
            $fatIndex = $FatOffset+[int][Math]::Floor($Cluster*1.5)
            if ($fatIndex+1 -ge $Image.Length) { throw 'Stock boot image FAT escaped its file.' }
            $value = [BitConverter]::ToUInt16($Image,$fatIndex)
            $Cluster = if ($Cluster -band 1) { $value -shr 4 } else { $value -band 0xFFF }
        }
        return ,$stream.ToArray()
    } finally { $stream.Dispose() }
}
function Fat-Entry([byte[]]$Directory, [string]$Name) {
    for ($offset=0; $offset+32 -le $Directory.Length; $offset+=32) {
        if ($Directory[$offset] -eq 0) { break }
        if ($Directory[$offset] -eq 0xE5 -or $Directory[$offset+11] -eq 0x0F) { continue }
        if ([Text.Encoding]::ASCII.GetString($Directory,$offset,11) -eq $Name) {
            return @{ cluster=[int][BitConverter]::ToUInt16($Directory,$offset+26); bytes=[int][BitConverter]::ToUInt32($Directory,$offset+28); directory=!!($Directory[$offset+11] -band 0x10) }
        }
    }
    throw "A stock boot image entry is missing: $Name"
}
function Assert-Arm64EfiImage([string]$Path) {
    $image = [IO.File]::ReadAllBytes((Assert-NoReparse $Path))
    if ($image.Length -lt 512 -or $image[510] -ne 0x55 -or $image[511] -ne 0xAA) { throw 'Stock EFI boot image signature is invalid.' }
    $bps=[int][BitConverter]::ToUInt16($image,11); $spc=[int]$image[13]; $reserved=[int][BitConverter]::ToUInt16($image,14); $fats=[int]$image[16]
    $rootEntries=[int][BitConverter]::ToUInt16($image,17); $fatSectors=[int][BitConverter]::ToUInt16($image,22)
    if ($bps -ne 512 -or $spc -notin @(1,2,4,8) -or $reserved -lt 1 -or $fats -notin @(1,2) -or $rootEntries -lt 1 -or $fatSectors -lt 1) { throw 'Unsupported stock FAT12 boot image geometry.' }
    $rootOffset=($reserved+$fats*$fatSectors)*$bps; $rootLength=$rootEntries*32
    $dataOffset=$rootOffset+[int][Math]::Ceiling($rootLength/$bps)*$bps; $fatOffset=$reserved*$bps; $clusterBytes=$spc*$bps
    if ($rootOffset+$rootLength -gt $image.Length) { throw 'Stock EFI root directory escaped its file.' }
    $directory=[byte[]]::new($rootLength); [Array]::Copy($image,$rootOffset,$directory,0,$rootLength)
    foreach ($name in @('EFI        ','BOOT       ')) {
        $entry=Fat-Entry $directory $name
        if (-not $entry.directory) { throw 'Stock EFI directory entry is not a directory.' }
        $directory=Read-FatChain $image $entry.cluster $fatOffset $dataOffset $clusterBytes
    }
    $entry=Fat-Entry $directory 'BOOTAA64EFI'
    if ($entry.directory -or $entry.bytes -lt 64) { throw 'Stock BOOTAA64.EFI entry is invalid.' }
    $binary=Read-FatChain $image $entry.cluster $fatOffset $dataOffset $clusterBytes
    if ($entry.bytes -gt $binary.Length) { throw 'Stock BOOTAA64.EFI is truncated.' }
    $bytes=[byte[]]::new($entry.bytes); [Array]::Copy($binary,0,$bytes,0,$entry.bytes)
    Assert-Arm64PeBytes $bytes 'Stock El Torito BOOTAA64.EFI'
}


try {
    Assert-NoReparse $workspace | Out-Null
    Assert-NoReparse $build | Out-Null
    $privateRoot = Join-Path $workspace 'private'
    $bootConfigPath = Assert-NoReparse $PrivateBootSource
    if (-not $bootConfigPath.StartsWith($privateRoot+[IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The licensed boot source receipt must remain in this workspace private directory.' }
    foreach ($existing in @($media,$iso,(Join-Path $build 'iso-receipt.json'),(Join-Path $build 'boot-media-manifest.json'),(Join-Path $build 'Iso-result.json'),(Join-Path $build 'iso-output.txt'))) {
        Assert-Owned $existing | Out-Null
        if (Test-Path -LiteralPath $existing) { throw 'Existing media or build evidence will not be overwritten. Use a fresh build.' }
    }
    $started = $true
    $bootConfigHash = FileHash $bootConfigPath
    $bootSource = Get-Content -LiteralPath $bootConfigPath -Raw | ConvertFrom-Json
    if ($bootSource.format -ne 'volterra-private-boot-source-v1' -or $bootSource.architecture -ne 'arm64' -or $bootSource.privateDevelopmentOnly -ne $true -or $bootSource.publicDistributionAllowed -ne $false) { throw 'A private ARM64 boot source receipt is required.' }
    foreach ($input in @($bootSource.sourceIso.path,$bootSource.sourceIso.manifestPath,$bootSource.oscdimg.path,$bootSource.validationLicense.path,$bootSource.priorMediaProof.isoReceiptPath,$bootSource.priorMediaProof.screenPath)) {
        if ($input -notmatch '^[A-Za-z]:[\\/]') { throw 'Private boot inputs must use absolute local file paths.' }
        Assert-NoReparse $input | Out-Null
    }
    if ($bootSource.priorMediaProof.runtimeAccepted -ne $false -or $bootSource.priorMediaProof.physicalHardwareAccepted -ne $false) { throw 'The media proof must not claim guest runtime or physical hardware acceptance.' }
    Require-Hash $bootSource.priorMediaProof.isoReceiptPath $bootSource.priorMediaProof.isoReceiptSHA256
    Require-Hash $bootSource.priorMediaProof.screenPath $bootSource.priorMediaProof.screenSHA256
    $prior = Get-Content -LiteralPath $bootSource.priorMediaProof.isoReceiptPath -Raw | ConvertFrom-Json
    if ($prior.architecture -ne 'arm64' -or $prior.privateDevelopmentOnly -ne $true -or $prior.sha256 -ne $bootSource.priorMediaProof.isoSHA256 -or $prior.sourceCommit -ne $bootSource.priorMediaProof.sourceCommit -or $prior.stockSourceIsoSHA256 -ne $bootSource.sourceIso.sha256 -or $prior.stockBcdSHA256 -ne $bootSource.bootFiles.'efi/Microsoft/Boot/BCD' -or $prior.stockEfiImageSHA256 -ne $bootSource.bootFiles.'efi/Microsoft/Boot/efisys_noprompt.bin') { throw 'The private stock boot source differs from the previously reviewed media recipe.' }
    $requiredBootFiles = @('efi/Microsoft/Boot/BCD','efi/boot/bootaa64.efi','bootmgr.efi','boot/boot.sdi','efi/Microsoft/Boot/efisys_noprompt.bin')
    if (@($bootSource.bootFiles.PSObject.Properties).Count -ne $requiredBootFiles.Count) { throw 'The stock boot file pins are incomplete.' }
    foreach ($file in $requiredBootFiles) { if ($bootSource.bootFiles.$file -notmatch '^[a-fA-F0-9]{64}$') { throw 'A stock boot file hash is invalid.' } }
    Require-Hash $bootSource.sourceIso.manifestPath $bootSource.sourceIso.manifestSHA256
    $manifest = Get-Content -LiteralPath $bootSource.sourceIso.manifestPath -Raw | ConvertFrom-Json
    if ($manifest.format -ne 'cwdk-windows-source-v1' -or $manifest.sha256 -ne $bootSource.sourceIso.sha256 -or $manifest.bytes -ne $bootSource.sourceIso.bytes) { throw 'The local Microsoft ARM64 source manifest differs.' }
    $sourceIso = Assert-NoReparse $bootSource.sourceIso.path
    $sourceLock = [IO.File]::Open($sourceIso,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    Require-Hash $sourceIso $bootSource.sourceIso.sha256
    if ((Get-Item -LiteralPath $sourceIso).Length -ne $bootSource.sourceIso.bytes) { throw 'The private stock ISO size differs.' }
    $oscdimg = Assert-NoReparse $bootSource.oscdimg.path
    Require-Hash $oscdimg $bootSource.oscdimg.sha256
    Assert-Arm64Pe $oscdimg
    Require-Hash $bootSource.validationLicense.path $bootSource.validationLicense.sha256
    $finalized = Join-Path $build 'Finalize-result.json'
    if (-not (Test-Path -LiteralPath $finalized)) { & (Join-Path $PSScriptRoot 'Finalize-ImagePayload.ps1') -BuildName $BuildName }
    $finalSource = Get-Content -LiteralPath (Assert-NoReparse $finalized) -Raw | ConvertFrom-Json
    $resultPath = Assert-NoReparse (Join-Path $build 'output/result.json')
    $receiptPath = Assert-NoReparse (Join-Path $build 'image-receipt.json')
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($finalSource.status -ne 'passed' -or $receipt.sourceCommit -notmatch '^[a-f0-9]{40}$' -or $finalSource.sourceCommit -ne $receipt.sourceCommit -or $receipt.helperBuild -ne $BuildName) { throw 'The finalized image must be bound to this build and its checked source commit.' }
    if ($result.status -ne 'passed' -or $result.build -ne 'development-006') { throw 'Successful VM servicing is required.' }
    $sealedInputs = [ordered]@{ 'Finalize-result.json'=(FileHash $finalized); 'image-receipt.json'=(FileHash $receiptPath); 'output/result.json'=(FileHash $resultPath) }
    $bootWim = Join-Path $build 'output/boot.wim'
    $installWim = Join-Path $build 'output/install.wim'
    Require-Hash $bootWim $receipt.bootSHA256
    Require-Hash $installWim $receipt.installSHA256
    $diskImage = Get-DiskImage -ImagePath $sourceIso -ErrorAction Stop
    if (-not $diskImage.Attached) { Mount-DiskImage -ImagePath $sourceIso -StorageType ISO -Access ReadOnly -PassThru | Out-Null; $mountedHere=$true }
    $diskImage = Get-DiskImage -ImagePath $sourceIso -ErrorAction Stop
    if (-not $diskImage.Attached -or [IO.Path]::GetFullPath($diskImage.ImagePath) -ne $sourceIso) { throw 'The exact private source ISO mount was not identified.' }
    $volumes = @($diskImage | Get-Volume)
    if ($volumes.Count -ne 1 -or -not $volumes[0].DriveLetter -or $volumes[0].FileSystem -ne 'UDF') { throw 'The private source ISO has no unambiguous UDF volume.' }
    $sourceRoot = [string]$volumes[0].DriveLetter + ':\'
    foreach ($file in $requiredBootFiles) { Require-Hash (Join-Path $sourceRoot $file) $bootSource.bootFiles.$file }
    Assert-Arm64Pe (Join-Path $sourceRoot 'efi/boot/bootaa64.efi')
    Assert-Arm64Pe (Join-Path $sourceRoot 'bootmgr.efi')
    Assert-Arm64EfiImage (Join-Path $sourceRoot 'efi/Microsoft/Boot/efisys_noprompt.bin')
    Folder $media
    Copy-Tree (Join-Path $sourceRoot 'efi') (Join-Path $media 'efi')
    Copy-Tree (Join-Path $sourceRoot 'boot') (Join-Path $media 'boot')
    Copy-One (Join-Path $sourceRoot 'bootmgr.efi') (Join-Path $media 'bootmgr.efi') $bootSource.bootFiles.'bootmgr.efi'
    $legacyManagerPresent = Test-Path -LiteralPath (Join-Path $sourceRoot 'bootmgr')
    if ($legacyManagerPresent) { Copy-One (Join-Path $sourceRoot 'bootmgr') (Join-Path $media 'bootmgr') }
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $media 'efi') -Filter '*.efi' -Recurse -File) { Assert-Arm64Pe $file.FullName }
    Folder (Join-Path $media 'sources')
    Copy-One $bootWim (Join-Path $media 'sources/boot.wim') $receipt.bootSHA256
    Copy-One $installWim (Join-Path $media 'sources/install.wim') $receipt.installSHA256
    Copy-One $bootSource.validationLicense.path (Join-Path $media 'Microsoft-Validation-OS-license.rtf') $bootSource.validationLicense.sha256
    foreach ($file in $requiredBootFiles) { Require-Hash (Join-Path $media $file) $bootSource.bootFiles.$file }
    $efiImage = Join-Path $media 'efi/Microsoft/Boot/efisys_noprompt.bin'
    # Preserve the complete stock BCD bytes. Even BCDEdit enumeration can alter
    # hive metadata, so this assembly never opens source or media BCD with it.
    Save 'boot-media-manifest.json' @{ sourceIso=$sourceIso; sourceIsoSHA256=$bootSource.sourceIso.sha256; sourceIsoBytes=$bootSource.sourceIso.bytes; privateBootSourceSHA256=$bootConfigHash; files=$mediaFiles.ToArray(); stockBcdPreserved=$true; stockEfiImageSHA256=$bootSource.bootFiles.'efi/Microsoft/Boot/efisys_noprompt.bin'; rootBootmgrPresent=$legacyManagerPresent; legacyBootBcdPresent=(Test-Path -LiteralPath (Join-Path $media 'boot/BCD')); stockLayoutPreserved=$true; architecture='arm64'; priorMediaProof=$bootSource.priorMediaProof; privateDevelopmentOnly=$true; redistributionRightsEstablished=$false; publicDistributionAllowed=$false }
    Assert-Owned $iso | Out-Null
    if (Test-Path -LiteralPath $iso) { throw 'Existing ISO output will not be overwritten.' }
    # Windows PowerShell 5 wraps redirected native stderr as ErrorRecords.
    # Oscdimg reports normal progress on stderr; its exit code determines success.
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $toolOutput = & $oscdimg -m -o -u2 -udfver102 -lVOLTERRA_ARM64 "-bootdata:1#pEF,e,b$efiImage" $media $iso 2>&1
        $toolExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    $outputBytes = [Text.UTF8Encoding]::new($false).GetBytes(($toolOutput -join [Environment]::NewLine))
    $outputFile = [IO.File]::Open((Assert-Owned (Join-Path $build 'iso-output.txt')),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $outputFile.Write($outputBytes,0,$outputBytes.Length); $outputFile.Flush($true) } finally { $outputFile.Dispose() }
    if ($toolExitCode -ne 0) { throw "ISO creation failed ($toolExitCode)." }
    foreach ($file in $mediaFiles) { Require-Hash (Join-Path $media $file.path) $file.sha256 }
    Require-Hash $bootWim $receipt.bootSHA256
    Require-Hash $installWim $receipt.installSHA256
    foreach ($input in $sealedInputs.Keys) { Require-Hash (Join-Path $build $input) $sealedInputs[$input] }
    Require-Hash $bootConfigPath $bootConfigHash
    Require-Hash $sourceIso $bootSource.sourceIso.sha256
    Require-Hash $oscdimg $bootSource.oscdimg.sha256
    Require-Hash $bootSource.sourceIso.manifestPath $bootSource.sourceIso.manifestSHA256
    Require-Hash $bootSource.validationLicense.path $bootSource.validationLicense.sha256
    Save 'iso-receipt.json' @{ path=$iso; sha256=(FileHash $iso); bytes=(Get-Item -LiteralPath $iso).Length; sourceCommit=$receipt.sourceCommit; helperBuild=$BuildName; architecture='arm64'; bootSHA256=$receipt.bootSHA256; installSHA256=$receipt.installSHA256; bootTested=$false; runtimeAccepted=$false; physicalTested=$false; privateDevelopmentOnly=$true; redistributionRightsEstablished=$false; publicDistributionAllowed=$false; stockSourceIsoSHA256=$bootSource.sourceIso.sha256; stockBcdSHA256=$bootSource.bootFiles.'efi/Microsoft/Boot/BCD'; stockEfiImageSHA256=$bootSource.bootFiles.'efi/Microsoft/Boot/efisys_noprompt.bin'; oscdimgSHA256=$bootSource.oscdimg.sha256; privateBootSourceSHA256=$bootConfigHash }
    Save 'Iso-result.json' @{ status='passed'; mediaBuildOnly=$true; bootTested=$false; runtimeAccepted=$false; physicalTested=$false; hostBootChanged=$false; installedToA=$false }
} catch {
    if ($started -and -not (Test-Path -LiteralPath (Join-Path $build 'Iso-result.json'))) { Save 'Iso-result.json' @{ status='failed'; error=$_.Exception.Message; bootTested=$false; runtimeAccepted=$false; physicalTested=$false; hostBootChanged=$false; installedToA=$false } }
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($mountedHere) {
        $currentImage = Get-DiskImage -ImagePath $sourceIso -ErrorAction Stop
        if ($currentImage.Attached -and [IO.Path]::GetFullPath($currentImage.ImagePath) -eq $sourceIso) { Dismount-DiskImage -ImagePath $sourceIso -ErrorAction Stop }
    }
    if ($sourceLock) { $sourceLock.Dispose() }
}
