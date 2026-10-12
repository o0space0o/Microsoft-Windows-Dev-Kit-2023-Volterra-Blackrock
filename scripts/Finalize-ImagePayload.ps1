#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^development-[0-9]{3}$')][string]$BuildName,
    [string]$SourceReceipt,
    [string]$CandidateDirectory,
    [string]$FeatureCompositionReceipt,
    [ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedFeatureCompositionSHA256,
    [string]$ApplicationOverlayAuthority,
    [ValidatePattern('^[A-F0-9]{64}$')][string]$ExpectedApplicationOverlayAuthoritySHA256
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'Image-Candidate.ps1')
$selection=Get-ImageBuildSelection $workspace $BuildName $CandidateDirectory ($PSBoundParameters.ContainsKey('CandidateDirectory'))
$build=$selection.build
$candidateBinding=Get-ImageCandidateBinding $selection $SourceReceipt $FeatureCompositionReceipt $ExpectedFeatureCompositionSHA256 $ApplicationOverlayAuthority $ExpectedApplicationOverlayAuthoritySHA256
# Finalized WIMs and accepted media are immutable inputs. An update needs a
# separately reviewed fresh candidate; never silently re-service current013.
foreach($seal in @('Finalize-result.json','iso-receipt.json')){
    if(Test-Path -LiteralPath (Join-Path $build $seal)){throw 'Existing finalized image or ISO proof forbids re-servicing this build.'}
}
$dism = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools\arm64\DISM\dism.exe'
function Dism([string]$Name,[string[]]$Arguments) {
    & $dism /English @Arguments "/LogPath:$build\$Name.log" > (Join-Path $build ($Name+'-output.txt'))
    if ($LASTEXITCODE -ne 0) { throw "File payload finalization failed ($Name, $LASTEXITCODE)." }
}
function Save-Finalization($Value){
    if($selection.candidate){
        $Value.candidateId=$selection.candidateId;$Value.artifactRoot=$build;$Value.candidateIdentitySHA256=$candidateBinding.identitySHA256;$Value.sourceReceiptSHA256=$candidateBinding.source.SHA256
        if($candidateBinding.identity.version-eq2){$Value.compositionSourceCommit=$candidateBinding.identity.sourceCommit;if($ApplicationOverlayAuthority){$Value.applicationSourceAuthoritySHA256=$candidateBinding.applicationOverlayAuthority.SHA256};$Value.featureCompositionSHA256=$candidateBinding.composition.SHA256;if($Value.status-ceq'passed'){$Value.sourceApplicationOverlayPerformed=$true;$Value.factsOverlayPerformed=$true}}
        Save-ImageCandidateJson (Join-Path $build 'Finalize-result.json') $Value $build
    }else{$Value | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $build 'Finalize-result.json') -Encoding utf8}
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
    if($selection.candidate-and$source.commit-cne$candidateBinding.source.value.commit){throw 'Candidate source commit changed.'}
    $factsStage = Join-Path $source.source 'scripts\Stage-WindowsFacts.mjs'
    if (-not $source.files.'scripts/Stage-WindowsFacts.mjs' -or (Get-FileHash -LiteralPath $factsStage -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source.files.'scripts/Stage-WindowsFacts.mjs') { throw 'The private facts staging helper is not bound to the immutable checked source.' }
    $receipt = Get-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Raw | ConvertFrom-Json
    if($selection.candidate){Assert-ImageCandidateBaseInputs $selection $candidateBinding}
    $factsByImage = @{}
    $overlayArgs=if($ApplicationOverlayAuthority){@($ApplicationOverlayAuthority,$ExpectedApplicationOverlayAuthoritySHA256)}else{@()}
    foreach ($kind in @('boot','install')) {
        $wim = Join-Path $build "output\$kind.wim"
        if($selection.candidate){Assert-ImageCandidatePath $wim $build | Out-Null}
        if ((Get-FileHash -LiteralPath $wim).Hash -ne $receipt.($kind+'SHA256')) { throw 'Serviced image hash changed.' }
        $mount = Join-Path $build ('final-'+$kind)
        if (Test-Path -LiteralPath $mount) { throw 'An existing finalization mount will not be reused.' }
        New-Item -ItemType Directory -Path $mount | Out-Null
        Dism ('final-mount-'+$kind) @('/Mount-Image',"/ImageFile:$wim",'/Index:1',"/MountDir:$mount")
        $copied = & $node (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --copy $SourceReceipt $mount @overlayArgs
        if ($LASTEXITCODE -ne 0 -or ($copied | ConvertFrom-Json).commit -ne $source.commit) { throw 'The offline payload does not match its checked source commit.' }
        if($ApplicationOverlayAuthority){Assert-ImageApplicationOverlayStageResult ($copied|ConvertFrom-Json) $candidateBinding}
        $factsCopied = & $node $factsStage $SourceReceipt $workspace $mount copy @overlayArgs
        if ($LASTEXITCODE -ne 0 -or ($factsCopied | ConvertFrom-Json).sourceCommit -ne $source.commit) { throw 'The private original facts tool does not match its checked source provenance.' }
        $factsCopyReceipt = $factsCopied | ConvertFrom-Json
        if($ApplicationOverlayAuthority){Assert-ImageApplicationOverlayStageResult $factsCopyReceipt $candidateBinding -Facts}
        Dism ('final-commit-'+$kind) @('/Unmount-Image',"/MountDir:$mount",'/Commit','/CheckIntegrity')
        $receipt.($kind+'SHA256') = (Get-FileHash -LiteralPath $wim).Hash
        # Read the committed two-file payload back through a read-only mount.
        # Never copy private credentials or the complete tools directory.
        $wimCommittedHash = $receipt.($kind+'SHA256')
        Dism ('facts-verify-mount-'+$kind) @('/Mount-Image',"/ImageFile:$wim",'/Index:1',"/MountDir:$mount",'/ReadOnly')
        try {
            $factsVerified = & $node $factsStage $SourceReceipt $workspace $mount verify @overlayArgs
            if ($LASTEXITCODE -ne 0) { throw 'The committed private facts payload could not be verified.' }
            $factsVerifyReceipt = $factsVerified | ConvertFrom-Json
            if($ApplicationOverlayAuthority){Assert-ImageApplicationOverlayStageResult $factsVerifyReceipt $candidateBinding -Facts}
            if ($factsVerifyReceipt.sourceCommit -ne $source.commit -or $factsVerifyReceipt.executableSHA256 -ne $factsCopyReceipt.executableSHA256 -or $factsVerifyReceipt.provenanceSHA256 -ne $factsCopyReceipt.provenanceSHA256) { throw 'The committed private facts payload differs from its pre-commit copy.' }
            $factsVerifyReceipt | Add-Member -NotePropertyName postCommitReadbackVerified -NotePropertyValue $true
            $factsByImage[$kind] = $factsVerifyReceipt
        } finally { Dism ('facts-verify-unmount-'+$kind) @('/Unmount-Image',"/MountDir:$mount",'/Discard') }
        if ((Get-FileHash -LiteralPath $wim).Hash -ne $wimCommittedHash) { throw 'The WIM bytes changed during read-only facts verification.' }
    }
    $receipt | Add-Member -NotePropertyName helperBuild -NotePropertyValue $BuildName -Force
    $receipt | Add-Member -NotePropertyName sourceCommit -NotePropertyValue $source.commit -Force
    $receipt | Add-Member -NotePropertyName sourceFiles -NotePropertyValue $source.files -Force
    $receipt | Add-Member -NotePropertyName privateOriginalFacts -NotePropertyValue $factsByImage -Force
    if($selection.candidate){
        $receipt | Add-Member -NotePropertyName candidateId -NotePropertyValue $selection.candidateId -Force
        $receipt | Add-Member -NotePropertyName artifactRoot -NotePropertyValue $build -Force
        $receipt | Add-Member -NotePropertyName candidateIdentitySHA256 -NotePropertyValue $candidateBinding.identitySHA256 -Force
        $receipt | Add-Member -NotePropertyName sourceReceiptSHA256 -NotePropertyValue $candidateBinding.source.SHA256 -Force
        if($candidateBinding.identity.version-eq2){
            $receipt | Add-Member -NotePropertyName compositionSourceCommit -NotePropertyValue $candidateBinding.identity.sourceCommit -Force
            if($ApplicationOverlayAuthority){$receipt | Add-Member -NotePropertyName applicationSourceAuthoritySHA256 -NotePropertyValue $candidateBinding.applicationOverlayAuthority.SHA256 -Force}
            $receipt | Add-Member -NotePropertyName featureCompositionSHA256 -NotePropertyValue $candidateBinding.composition.SHA256 -Force
            $receipt | Add-Member -NotePropertyName sourceApplicationOverlayPerformed -NotePropertyValue $true -Force
            $receipt | Add-Member -NotePropertyName factsOverlayPerformed -NotePropertyValue $true -Force
        }
        Get-ImageCandidateBinding $selection $SourceReceipt $FeatureCompositionReceipt $ExpectedFeatureCompositionSHA256 $ApplicationOverlayAuthority $ExpectedApplicationOverlayAuthoritySHA256 | Out-Null
    }
    if($selection.candidate){Assert-ImageCandidatePath (Join-Path $build 'image-receipt.json') $build | Out-Null}
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Encoding utf8
    Save-Finalization @{ status='passed'; fileOverlayOnly=$true; sourceCommit=$source.commit; runtimeAcceptancePending=$true }
} catch { Save-Finalization @{status='failed';error=$_.Exception.Message}; exit 1 }
