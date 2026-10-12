# Shared declarations only. Candidate artifacts retain development-013 and never replace current media.
function Assert-ImageCandidatePathLength([string]$Path,[switch]$Directory) {
    $limit=if($Directory){247}else{259}
    if(-not$Path-or$Path.Length-gt$limit){throw 'Candidate path exceeds the plain Windows PowerShell5 file/directory limit.'}
}
function Get-ImageBuildSelection([string]$Workspace,[string]$BuildName,[string]$CandidateDirectory,[bool]$CandidateRequested) {
    $root=[IO.Path]::GetFullPath($Workspace)
    if($BuildName-cnotmatch'^development-[0-9]{3}$'-or$BuildName.Length-ne15){throw 'Explicit valid BuildName required.'}
    if(-not$CandidateRequested){return [pscustomobject]@{workspace=$root;buildName=$BuildName;build=(Join-Path $root ('build/'+$BuildName));candidate=$false;candidateId=$null}}
    if($BuildName-cne'development-013'-or-not$CandidateDirectory-or$CandidateDirectory-notmatch'^[A-Za-z]:[\\/]'-or$CandidateDirectory-match'[\x00-\x1f]' ){throw 'Candidate mode requires development-013 and an explicit absolute directory.'}
    foreach($part in $CandidateDirectory.Substring(3).Split([char[]]'\/')){if(-not$part-or$part-in@('.','..')-or$part.TrimEnd(' ','.')-cne$part-or$part-match'[<>:"|?*]'){throw 'Ambiguous candidate directory component rejected.'}}
    $full=[IO.Path]::GetFullPath($CandidateDirectory)
    $parent=Join-Path $root 'build/verification'
    if(-not[string]::Equals((Split-Path -Parent $full),$parent,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate directory must be an immediate child of workspace build/verification.'}
    $leaf=[IO.Path]::GetFileName($full)
    if($leaf-cnotmatch'^media-candidate-development-013-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$'){throw 'Candidate directory needs the exact013 prefix and canonical lowercase UUID.'}
    $identifier=$Matches[1];$parsed=[Guid]::Empty
    if(-not[Guid]::TryParseExact($identifier,'D',[ref]$parsed)-or$parsed-eq[Guid]::Empty-or$parsed.ToString('D')-cne$identifier){throw 'Candidate UUID differs.'}
    foreach($relative in @('','output','final-boot','final-install','iso-media','iso-media/sources')){Assert-ImageCandidatePathLength ($(if($relative){Join-Path $full $relative}else{$full})) -Directory}
    foreach($relative in @('candidate-identity.json','Microsoft-Volterra-development-013-arm64.iso','facts-verify-unmount-install-output.txt','output/install.wim','iso-media/sources/install.wim')){Assert-ImageCandidatePathLength (Join-Path $full $relative)}
    return [pscustomobject]@{workspace=$root;buildName=$BuildName;build=$full;candidate=$true;candidateId=$identifier}
}
function Assert-ImageCandidatePath([string]$Path,[string]$Root,[switch]$AllowMissing) {
    $full=[IO.Path]::GetFullPath($Path);$base=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    Assert-ImageCandidatePathLength $full
    if(-not[string]::Equals($full,$base,[StringComparison]::OrdinalIgnoreCase)-and-not$full.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate path escaped its exact root.'}
    for($cursor=$full;$cursor;$cursor=Split-Path -Parent $cursor){
        try{$attributes=[IO.File]::GetAttributes($cursor)}catch{
            $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}
            if($AllowMissing-and(($failure-is[IO.FileNotFoundException]-and($failure.HResult-band65535)-eq2)-or($failure-is[IO.DirectoryNotFoundException]-and($failure.HResult-band65535)-eq3))){continue};throw
        }
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if($null-eq$item-or$item.PSProvider.Name-cne'FileSystem'-or($attributes-band[IO.FileAttributes]::ReparsePoint)-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-or$item.LinkType-eq'HardLink'-or$item.LinkType-eq'SymbolicLink'-or$item.LinkType-eq'Junction'){throw 'Redirected, hardlinked or unsupported candidate path rejected.'}
    }
    return $full
}
function Read-ImageCandidateFile([string]$Path,[string]$Root) {
    $full=Assert-ImageCandidatePath $Path $Root;$item=Get-Item -LiteralPath $full -Force
    if($item.PSIsContainer-or$item.Length-lt2-or$item.Length-gt131072){throw 'A bounded ordinary candidate JSON input is required.'}
    $streams=@(Get-Item -LiteralPath $full -Stream '*' -Force -ErrorAction Stop)
    if($streams.Count-ne1-or$streams[0].Stream-cne':$DATA'){throw 'Named candidate input streams are forbidden.'}
    $stream=[IO.File]::Open($full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length-ne$item.Length){throw 'Candidate JSON input changed.'}
        $buffer=[byte[]]::new([int]$item.Length);$offset=0
        while($offset-lt$buffer.Length){$count=$stream.Read($buffer,$offset,$buffer.Length-$offset);if(-not$count){throw 'Candidate JSON input ended early.'};$offset+=$count}
        if($stream.ReadByte()-ne-1){throw 'Candidate JSON input grew.'}
        $hasher=[Security.Cryptography.SHA256]::Create()
        try{$hash=[BitConverter]::ToString($hasher.ComputeHash($buffer)).Replace('-','')}finally{$hasher.Dispose()}
        $value=[Text.UTF8Encoding]::new($false,$true).GetString($buffer).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash-cne$hash){throw 'Candidate JSON input changed during read.'}
        Assert-ImageCandidatePath $full $Root | Out-Null
        return [pscustomobject]@{path=$full;SHA256=$hash;value=$value}
    }finally{$stream.Dispose()}
}
function Get-ImageCandidateSource([string]$SourceReceipt,[string]$Workspace) {
    if(-not$SourceReceipt){throw 'Candidate mode requires an explicit checked SourceReceipt.'}
    $inputRecord=Read-ImageCandidateFile $SourceReceipt (Join-Path $Workspace 'build/source-snapshots')
    $source=$inputRecord.value
    if(($source.version-isnot[int]-and$source.version-isnot[long])-or$source.version-ne1-or$source.checksPassed-isnot[bool]-or$source.checksPassed-ne$true-or$source.commit-isnot[string]-or$source.commit-cnotmatch'^[a-f0-9]{40}$'-or$source.files-isnot[pscustomobject]-or-not@($source.files.PSObject.Properties).Count){throw 'Candidate needs a checked immutable source receipt.'}
    return $inputRecord
}
function Assert-ImageCandidateIdentity($Selection,$Record,$Source) {
    $value=$Record.value;$base=Join-Path $Selection.workspace 'build/development-006'
    if(($value.version-isnot[int]-and$value.version-isnot[long])-or$value.version-ne1){throw 'Candidate identity version must be an integer1.'}
    foreach($name in @('privateDevelopmentOnly','publicDistributionAllowed','bootAccepted','runtimeAccepted','recoveryAccepted','physicalHardwareAccepted')){if($value.$name-isnot[bool]){throw 'Candidate identity flags must be JSON booleans.'}}
    if($value.version-ne1-or$value.kind-cne'volterraImageCandidateV1'-or$value.buildName-cne'development-013'-or$value.candidateId-cne$Selection.candidateId-or-not[string]::Equals($value.artifactRoot,$Selection.build,[StringComparison]::OrdinalIgnoreCase)-or-not[string]::Equals($value.sourceReceipt,$Source.path,[StringComparison]::OrdinalIgnoreCase)-or$value.sourceReceiptSHA256-cne$Source.SHA256-or$value.sourceCommit-cne$Source.value.commit-or-not[string]::Equals($value.baseArtifactRoot,$base,[StringComparison]::OrdinalIgnoreCase)-or$value.privateDevelopmentOnly-ne$true-or$value.publicDistributionAllowed-ne$false-or$value.bootAccepted-ne$false-or$value.runtimeAccepted-ne$false-or$value.recoveryAccepted-ne$false-or$value.physicalHardwareAccepted-ne$false){throw 'Exact owned candidate identity/source binding differs.'}
    foreach($name in @('baseImageReceiptSHA256','baseBootSHA256','baseInstallSHA256')){if($value.$name-cnotmatch'^[A-F0-9]{64}$'){throw 'Candidate base input hash differs.'}}
}
function Get-ImageCandidateBinding($Selection,[string]$SourceReceipt,[string]$FeatureCompositionReceipt,[string]$ExpectedFeatureCompositionSHA256) {
    $featureRequested=([bool]$FeatureCompositionReceipt-or[bool]$ExpectedFeatureCompositionSHA256)
    if(-not$Selection.candidate){if($featureRequested){throw 'Feature authority is only allowed for an explicit candidate.'};return $null}
    Assert-ImageCandidatePath $Selection.build $Selection.build | Out-Null
    $source=Get-ImageCandidateSource $SourceReceipt $Selection.workspace
    $record=Read-ImageCandidateFile (Join-Path $Selection.build 'candidate-identity.json') $Selection.build
    if($record.value.version-eq2){return Get-ImageFeatureCandidateBinding $Selection $SourceReceipt $FeatureCompositionReceipt $ExpectedFeatureCompositionSHA256}
    if($featureRequested){throw 'A v1 candidate cannot consume feature authority.'}
    Assert-ImageCandidateIdentity $Selection $record $source
    return [pscustomobject]@{identity=$record.value;identitySHA256=$record.SHA256;source=$source}
}
function Assert-ImageCandidateBaseInputs($Selection,$Binding) {
    if($Binding.identity.version-eq2){Assert-ImageFeatureCandidateInitialInputs $Selection $Binding;return}
    $record=Read-ImageCandidateFile (Join-Path $Selection.build 'image-receipt.json') $Selection.build
    if($record.SHA256-cne$Binding.identity.baseImageReceiptSHA256-or$record.value.bootSHA256-cne$Binding.identity.baseBootSHA256-or$record.value.installSHA256-cne$Binding.identity.baseInstallSHA256){throw 'Initial candidate image receipt differs from its immutable base binding.'}
    foreach($kind in @('boot','install')){
        $wim=Assert-ImageCandidatePath (Join-Path $Selection.build ('output/'+$kind+'.wim')) $Selection.build
        if((Get-Item -LiteralPath $wim -Force).PSIsContainer-or(Get-FileHash -LiteralPath $wim -Algorithm SHA256).Hash-cne$Binding.identity.('base'+$(if($kind-eq'boot'){'Boot'}else{'Install'})+'SHA256')){throw 'Initial candidate WIM differs from its immutable base binding.'}
    }
}
function Save-ImageCandidateJson([string]$Path,$Value,[string]$Root) {
    $full=Assert-ImageCandidatePath $Path $Root -AllowMissing
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20))
    $stream=[IO.File]::Open($full,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    Assert-ImageCandidatePath $full $Root | Out-Null
}
function New-ImageCandidateBinding($Selection,$Source,[string]$BaseReceiptSHA256,[string]$BootSHA256,[string]$InstallSHA256) {
    if(-not$Selection.candidate){throw 'Only explicit candidate mode can create a candidate identity.'}
    Assert-ImageCandidatePath $Selection.build $Selection.build -AllowMissing | Out-Null
    try{[IO.File]::GetAttributes($Selection.build) | Out-Null;throw 'An existing candidate directory cannot be reused.'}catch{
        $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}
        if(-not(($failure-is[IO.FileNotFoundException]-and($failure.HResult-band65535)-eq2)-or($failure-is[IO.DirectoryNotFoundException]-and($failure.HResult-band65535)-eq3))){throw}
    }
    Assert-ImageCandidatePath (Split-Path -Parent $Selection.build) (Join-Path $Selection.workspace 'build/verification') | Out-Null
    [IO.Directory]::CreateDirectory($Selection.build) | Out-Null
    $value=[ordered]@{version=1;kind='volterraImageCandidateV1';candidateId=$Selection.candidateId;buildName='development-013';artifactRoot=$Selection.build;sourceReceipt=$Source.path;sourceReceiptSHA256=$Source.SHA256;sourceCommit=$Source.value.commit;baseArtifactRoot=(Join-Path $Selection.workspace 'build/development-006');baseImageReceiptSHA256=$BaseReceiptSHA256;baseBootSHA256=$BootSHA256;baseInstallSHA256=$InstallSHA256;privateDevelopmentOnly=$true;publicDistributionAllowed=$false;bootAccepted=$false;runtimeAccepted=$false;recoveryAccepted=$false;physicalHardwareAccepted=$false}
    Save-ImageCandidateJson (Join-Path $Selection.build 'candidate-identity.json') $value $Selection.build
    return Get-ImageCandidateBinding $Selection $Source.path
}
function Copy-ImageCandidateInput([string]$From,[string]$To,[string]$Expected,[string]$Workspace,[string]$CandidateRoot) {
    $source=Assert-ImageCandidatePath $From (Join-Path $Workspace 'build/development-006')
    $target=Assert-ImageCandidatePath $To $CandidateRoot -AllowMissing
    if((Get-Item -LiteralPath $source -Force).PSIsContainer){throw 'A candidate copy requires an ordinary input file.'}
    $read=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash-cne$Expected){throw 'Sealed candidate input hash differs.'}
        $write=[IO.File]::Open($target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$read.CopyTo($write);$write.Flush($true)}finally{$write.Dispose()}
        Assert-ImageCandidatePath $target $CandidateRoot | Out-Null
        if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash-cne$Expected-or(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash-cne$Expected){throw 'Candidate copy changed sealed input or output bytes.'}
    }finally{$read.Dispose()}
}

function Assert-ImageFeatureCandidateIdentity($Selection,$Record,$Source,$Composition) {
    $value=$Record.value;$proof=$Composition.value
    if(-not$Selection.candidate-or$Selection.buildName-cne'development-013'){throw 'Only the explicit same013 candidate may consume composition authority.'}
    if(($value.version-isnot[int]-and$value.version-isnot[long])-or$value.version-ne2-or$value.kind-cne'volterraFeatureImageCandidateV2'-or$value.inputKind-cne'officialPredefinedWpfComposition'-or$value.candidateId-cne$Selection.candidateId-or$value.buildName-cne'development-013'-or$value.artifactRoot-cne$Selection.build-or$value.sourceReceipt-cne$Source.path-or$value.sourceReceiptSHA256-cne$Source.SHA256-or$value.sourceCommit-cne$Source.value.commit-or$value.compositionReceipt-cne'feature-composition.json'-or$value.compositionReceiptSHA256-cne$Composition.SHA256){throw 'Exact separate feature-candidate identity/source authority differs.'}
    foreach($name in @('privateDevelopmentOnly','publicDistributionAllowed','bootAccepted','runtimeAccepted','recoveryAccepted','physicalHardwareAccepted','approvedVisualMatch','apiCompatibilityAccepted')){if($value.$name-isnot[bool]-or$value.$name-ne($name-ceq'privateDevelopmentOnly')){throw 'Feature-candidate acceptance must remain false.'}}
    foreach($name in @('compositionReceiptSHA256','technicianStagingSHA256','inputBindingSHA256','initialImageReceiptSHA256','initialBootSHA256','initialInstallSHA256')){if($value.$name-isnot[string]-or$value.$name-cnotmatch'^[A-F0-9]{64}$'){throw 'Feature-candidate input seal differs.'}}
    if(($proof.version-isnot[int]-and$proof.version-isnot[long])-or$proof.version-ne1-or$proof.kind-cne'candidate013WpfCompositionCollected'-or$proof.status-cne'feature-composition-collected-awaiting-file-overlay'-or$proof.candidateId-cne$Selection.candidateId-or$proof.artifactRoot-cne$Selection.build-or$proof.sourceCommit-cne$Source.value.commit-or$proof.sourceReceiptSHA256-cne$Source.SHA256-or$proof.inputBindingSHA256-cne$value.inputBindingSHA256-or$proof.stagingReceiptSHA256-cne$value.technicianStagingSHA256-or$proof.initialImageReceiptSHA256-cne$value.initialImageReceiptSHA256-or$proof.technicianState-cne'Off'){throw 'Composition receipt is absent or belongs to another authority.'}
    foreach($name in @('technicianDisksDetached','sourceInputsUnchanged','completeGuestInputManifestMatched','packageInventoryBothExitZero','exactPackageAndVariantClosureVerified','driverFilesAndCatalogsVerified','runtime799FilesVerified')){if($proof.$name-isnot[bool]-or$proof.$name-ne$true){throw 'Measured composition completion is required.'}}
    foreach($name in @('sourceApplicationOverlayPerformed','factsOverlayPerformed','existing006Written','canonical013Written','publicDistributionAllowed','bootAccepted','runtimeAccepted','recoveryAccepted','physicalHardwareAccepted','approvedVisualMatch','apiCompatibilityAccepted')){if($proof.$name-isnot[bool]-or$proof.$name-ne$false){throw 'Composition cannot imply file overlay or acceptance.'}}
    $images=@($proof.images);if($images.Count-ne2){throw 'Only exact boot/install composition proofs permitted.'}
    $fonts=@('segoeui.ttf','segoeuib.ttf','seguisb.ttf','segoeuil.ttf','segoeuisl.ttf','seguivar.ttf')
    foreach($i in @(0,1)){
        $kind=if($i-eq0){'boot'}else{'install'};$image=$images[$i]
        $integerFields=@('index','sourceIndex','bootIndex','genImageExitCode','runtimeCopyExitCode','packageInventoryExitCode','driverInventoryExitCode','driverAddExitCode','startupDriveCode','bytes')
        foreach($name in $integerFields){if($image.$name-isnot[int]-and$image.$name-isnot[long]){throw 'Measured image numeric facts must be JSON integers.'}}
        $wantedSHA=if($i-eq0){$value.initialBootSHA256}else{$value.initialInstallSHA256}
        if($image.kind-cne$kind-or$image.path-cne(Join-Path $Selection.build ('output/'+$kind+'.wim'))-or$image.index-ne1-or$image.sourceIndex-ne$(if($i-eq0){2}else{1})-or($i-eq0-and$image.bootIndex-ne1)-or($i-eq1-and$image.bootIndex-notin@(0,1))-or$image.architecture-cne'arm64'-or$image.version-cne'10.0.26100.9549'-or$image.SHA256-cne$wantedSHA-or$image.bytes-le281080081-or$image.genImageExitCode-ne0-or$image.runtimeCopyExitCode-lt0-or$image.runtimeCopyExitCode-gt7-or$image.packageInventoryExitCode-ne0-or$image.driverInventoryExitCode-ne0-or$image.driverAddExitCode-ne0-or$image.startupDriveCode-ne$(if($i-eq0){88}else{67})){throw 'Measured source-index/architecture/runtime/startup/output differs.'}
        if($image.driverForceUnsignedRequested-isnot[bool]-or$image.driverForceUnsignedRequested-ne$false){throw 'Unsigned-driver override is refused.'}
        foreach($name in @('startupCurrentEqualsDefault','startupShellVerified','fontRegularAndVariableFilesVerified')){if($image.$name-isnot[bool]-or$image.$name-ne$true){throw 'Actual startup and complete font readback are required.'}}
        if((ConvertTo-Json -InputObject @($image.verifiedFontFiles) -Compress)-cne(ConvertTo-Json -InputObject $fonts -Compress)){throw 'Exact regular and variable font filenames required.'}
        foreach($name in @('sourceInputsUnchanged','wholeWimUnchangedDuringReadonlyVerification')){if($image.$name-isnot[bool]-or$image.$name-ne$true){throw 'Both readonly composed image preservation proofs are required.'}}
        foreach($name in @('fontRegistrationAccepted','guestRenderAccepted')){if($image.$name-isnot[bool]-or$image.$name-ne$false){throw 'Font readback cannot imply guest rendering or registration.'}}
        foreach($name in @('packageInventorySHA256','driverInventorySHA256','fontMetadataSHA256','payloadReadbackSHA256')){if($image.$name-isnot[string]-or$image.$name-cnotmatch'^[A-F0-9]{64}$'){throw 'Collected inventory/font seals differ.'}}
    }
}
function Get-ImageFeatureCandidateBinding($Selection,[string]$SourceReceipt,[string]$FeatureCompositionReceipt,[string]$ExpectedFeatureCompositionSHA256) {
    if(-not$Selection.candidate-or$Selection.buildName-cne'development-013'-or$ExpectedFeatureCompositionSHA256-cnotmatch'^[A-F0-9]{64}$'-or$FeatureCompositionReceipt-cne(Join-Path $Selection.build 'feature-composition.json')){throw 'Explicit same013 collected feature receipt and external reviewed SHA required.'}
    Assert-ImageCandidatePath $Selection.build $Selection.build|Out-Null
    $source=Get-ImageCandidateSource $SourceReceipt $Selection.workspace
    $identity=Read-ImageCandidateFile (Join-Path $Selection.build 'candidate-identity.json') $Selection.build
    $composition=Read-ImageCandidateFile $FeatureCompositionReceipt $Selection.build
    if($composition.SHA256-cne$ExpectedFeatureCompositionSHA256){throw 'Externally reviewed composition authority changed.'}
    Assert-ImageFeatureCandidateIdentity $Selection $identity $source $composition
    # The root collector must additionally call the pinned Node declarations
    # against exact preserved input-binding/staging records before authoring v2.
    # This loader never upgrades a draft or manufactures collection evidence.
    return [pscustomobject]@{identity=$identity.value;identitySHA256=$identity.SHA256;source=$source;composition=$composition;inputKind='officialPredefinedWpfComposition'}
}
function Assert-ImageFeatureCandidateInitialInputs($Selection,$Binding) {
    $record=Read-ImageCandidateFile (Join-Path $Selection.build 'image-receipt.json') $Selection.build
    if($record.SHA256-cne$Binding.identity.initialImageReceiptSHA256-or$record.value.bootSHA256-cne$Binding.identity.initialBootSHA256-or$record.value.installSHA256-cne$Binding.identity.initialInstallSHA256){throw 'Complete initial composed image receipt is not the collected authority.'}
    foreach($kind in @('boot','install')){
        $wanted=if($kind-ceq'boot'){$Binding.identity.initialBootSHA256}else{$Binding.identity.initialInstallSHA256}
        $file=Assert-ImageCandidatePath (Join-Path $Selection.build ('output/'+$kind+'.wim')) $Selection.build
        $meta=Get-Item -LiteralPath $file -Force
        $image=@($Binding.composition.value.images|Where-Object kind -CEQ $kind)
        if($meta.PSIsContainer-or$image.Count-ne1-or$meta.Length-ne$image[0].bytes-or(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash-cne$wanted){throw 'Composed WIM bytes differ before the first mount.'}
    }
}
