[CmdletBinding()]param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$proposal=Join-Path $PSScriptRoot 'Image-Candidate.ps1'
$public=$proposal
foreach($pair in @(@($proposal,@('Assert-ImageFeatureCandidateIdentity','Get-ImageFeatureCandidateBinding','Assert-ImageFeatureCandidateInitialInputs','Get-ImageCandidateBinding','Assert-ImageCandidateBaseInputs')),@($public,@('Assert-ImageCandidateIdentity')))){
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($pair[0],[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Candidate proposal parser failed.'}
 foreach($name in $pair[1]){$matches=@($ast.FindAll({param($node)$node-is[Management.Automation.Language.FunctionDefinitionAst]-and$node.Name-ceq$name},$true));if($matches.Count-ne1){throw 'Exact production declaration required.'};.([scriptblock]::Create($matches[0].Extent.Text))}
}
$passed=0
function Pass([scriptblock]$Body){&$Body;$script:passed++}
function Refuse([scriptblock]$Body){$refused=$false;try{&$Body}catch{$refused=$true};if(-not$refused){throw 'Expected exact authority refusal absent.'};$script:passed++}
$sha='A'*64;$cid='11111111-2222-4333-8444-555555555555'
$workspace='C:\Users\_420\Documents\Microsoft Windows Dev Kit 2023 Volterra Blackrock'
$root=Join-Path $workspace ('build/verification/media-candidate-development-013-'+$cid)
$selection=[pscustomobject]@{candidate=$true;workspace=$workspace;buildName='development-013';candidateId=$cid;build=$root}
$source=[pscustomobject]@{path=(Join-Path $workspace 'build/source-snapshots/ffffffffffff-22222222-3333-4444-8555-666666666666/source-receipt.json');SHA256=$sha;value=[pscustomobject]@{commit=('f'*40)}}
function Fixture {
 $identity=[ordered]@{version=2;kind='volterraFeatureImageCandidateV2';candidateId=$cid;buildName='development-013';artifactRoot=$root;sourceReceipt=$source.path;sourceReceiptSHA256=$sha;sourceCommit=('f'*40);inputKind='officialPredefinedWpfComposition';compositionReceipt='feature-composition.json';compositionReceiptSHA256=$sha;technicianStagingSHA256=$sha;inputBindingSHA256=$sha;initialImageReceiptSHA256=$sha;initialBootSHA256=$sha;initialInstallSHA256=$sha;privateDevelopmentOnly=$true;publicDistributionAllowed=$false;bootAccepted=$false;runtimeAccepted=$false;recoveryAccepted=$false;physicalHardwareAccepted=$false;approvedVisualMatch=$false;apiCompatibilityAccepted=$false}
 $proof=[ordered]@{version=1;kind='candidate013WpfCompositionCollected';status='feature-composition-collected-awaiting-file-overlay';candidateId=$cid;artifactRoot=$root;sourceCommit=('f'*40);sourceReceiptSHA256=$sha;inputBindingSHA256=$sha;stagingReceiptSHA256=$sha;initialImageReceiptSHA256=$sha;technicianState='Off';technicianDisksDetached=$true;sourceInputsUnchanged=$true;completeGuestInputManifestMatched=$true;packageInventoryBothExitZero=$true;exactPackageAndVariantClosureVerified=$true;driverFilesAndCatalogsVerified=$true;runtime799FilesVerified=$true;sourceApplicationOverlayPerformed=$false;factsOverlayPerformed=$false;existing006Written=$false;canonical013Written=$false;publicDistributionAllowed=$false;bootAccepted=$false;runtimeAccepted=$false;recoveryAccepted=$false;physicalHardwareAccepted=$false;approvedVisualMatch=$false;apiCompatibilityAccepted=$false;images=@()}
 foreach($kind in @('boot','install')){$boot=$kind-ceq'boot';$proof.images+=@([ordered]@{kind=$kind;path=(Join-Path $root ('output/'+$kind+'.wim'));index=1;sourceIndex=if($boot){2}else{1};bootIndex=1;architecture='arm64';version='10.0.26100.9549';SHA256=$sha;bytes=1700000000;genImageExitCode=0;runtimeCopyExitCode=3;packageInventoryExitCode=0;driverInventoryExitCode=0;driverAddExitCode=0;driverForceUnsignedRequested=$false;startupDriveCode=if($boot){88}else{67};startupCurrentEqualsDefault=$true;startupShellVerified=$true;fontRegularAndVariableFilesVerified=$true;verifiedFontFiles=@('segoeui.ttf','segoeuib.ttf','seguisb.ttf','segoeuil.ttf','segoeuisl.ttf','seguivar.ttf');packageInventorySHA256=$sha;driverInventorySHA256=$sha;fontMetadataSHA256=$sha;payloadReadbackSHA256=$sha;sourceInputsUnchanged=$true;wholeWimUnchangedDuringReadonlyVerification=$true;fontRegistrationAccepted=$false;guestRenderAccepted=$false})}
 # Exercise actual JSON PSCustomObject/property semantics in both PowerShells.
 return ([ordered]@{identity=[ordered]@{value=$identity;SHA256=$sha};composition=[ordered]@{value=$proof;SHA256=$sha}}|ConvertTo-Json -Depth 20|ConvertFrom-Json)
}
Pass{$f=Fixture;Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}
foreach($pair in @(@('version','2'),@('version',1),@('inputKind','base006'),@('kind','candidate013WpfCompositionDraft'),@('artifactRoot',(Join-Path $workspace 'build/development-013')),@('sourceCommit',('e'*40)),@('compositionReceiptSHA256',('B'*64)),@('privateDevelopmentOnly',$false),@('bootAccepted',$true),@('publicDistributionAllowed',$true),@('apiCompatibilityAccepted','false'),@('initialBootSHA256','bad'))){Refuse{$f=Fixture;$f.identity.value.($pair[0])=$pair[1];Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}}
foreach($pair in @(@('status','source-protocol-only-needs-fresh-reviewed-technician-staging'),@('technicianState','Running'),@('sourceInputsUnchanged',$false),@('packageInventoryBothExitZero',$false),@('runtime799FilesVerified',$false),@('stagingReceiptSHA256',('B'*64)),@('initialImageReceiptSHA256',('B'*64)),@('existing006Written',$true),@('sourceApplicationOverlayPerformed',$true),@('approvedVisualMatch',$true))){Refuse{$f=Fixture;$f.composition.value.($pair[0])=$pair[1];Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}}
foreach($pair in @(@('index',2),@('sourceIndex',1),@('bootIndex',0),@('genImageExitCode',1),@('runtimeCopyExitCode',8),@('packageInventoryExitCode',87),@('driverInventoryExitCode',1),@('driverAddExitCode',1),@('driverForceUnsignedRequested',$true),@('startupDriveCode',67),@('startupCurrentEqualsDefault',$false),@('startupShellVerified',$false),@('fontRegularAndVariableFilesVerified',$false),@('bytes','1700000000'),@('architecture','amd64'))){Refuse{$f=Fixture;$f.composition.value.images[0].($pair[0])=$pair[1];Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}}
Refuse{$f=Fixture;$f.composition.value.images[1].verifiedFontFiles=@('seguisbi.ttf');Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}
Pass{$f=Fixture;$f.composition.value.images[1].bootIndex=0;Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}
Refuse{$f=Fixture;Assert-ImageCandidateIdentity $selection $f.identity $source}
Refuse{$f=Fixture;$bad=[pscustomobject]@{candidate=$false;buildName='development-013'};Assert-ImageFeatureCandidateIdentity $bad $f.identity $source $f.composition}
function Assert-ImageCandidatePath([string]$Path,[string]$Root){if(-not$Path.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase)-and$Path-cne$Root){throw 'Mock path escaped.'};return $Path}
function Get-ImageCandidateSource([string]$Path,[string]$Workspace){if($Path-cne$source.path){throw 'Mock source differs.'};return $source}
$f=Fixture;$fixture=$f;$initialHash=$sha;$initialBoot=$sha;$initialInstall=$sha;$fileSHA=$sha;$fileBytes=1700000000
function Read-ImageCandidateFile([string]$Path,[string]$Root){
 if($Path-ceq(Join-Path $root 'candidate-identity.json')){return $fixture.identity}
 if($Path-ceq(Join-Path $root 'feature-composition.json')){return $fixture.composition}
 if($Path-ceq(Join-Path $root 'image-receipt.json')){return [pscustomobject]@{SHA256=$initialHash;value=[pscustomobject]@{bootSHA256=$initialBoot;installSHA256=$initialInstall}}}
 throw 'No unrelated mock read permitted.'
}
function Get-Item([string]$LiteralPath,[switch]$Force){if($LiteralPath-cnotin@((Join-Path $root 'output/boot.wim'),(Join-Path $root 'output/install.wim'))){throw 'No unrelated mock metadata permitted.'};return [pscustomobject]@{PSIsContainer=$false;Length=$fileBytes}}
function Get-FileHash([string]$LiteralPath,[string]$Algorithm){return [pscustomobject]@{Hash=$fileSHA}}
Pass{$binding=Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;Assert-ImageFeatureCandidateInitialInputs $selection $binding}
Refuse{Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') ''|Out-Null}
Refuse{Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'other.json') $sha|Out-Null}
Refuse{Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') ('B'*64)|Out-Null}
Refuse{$initialHash='B'*64;try{$binding=Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;Assert-ImageFeatureCandidateInitialInputs $selection $binding}finally{$initialHash=$sha}}
Refuse{$initialBoot='B'*64;try{$binding=Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;Assert-ImageFeatureCandidateInitialInputs $selection $binding}finally{$initialBoot=$sha}}
Refuse{$fileSHA='B'*64;try{$binding=Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;Assert-ImageFeatureCandidateInitialInputs $selection $binding}finally{$fileSHA=$sha}}
Refuse{$fileBytes++;try{$binding=Get-ImageFeatureCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;Assert-ImageFeatureCandidateInitialInputs $selection $binding}finally{$fileBytes--}}
Pass {$f=Fixture;$fixture=$f;$b=Get-ImageCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;if($b.identity.version-ne2-or$b.composition.SHA256-cne$sha){throw 'Actual v2 dispatch lost reviewed composition.'};Assert-ImageCandidateBaseInputs $selection $b}
Refuse {Get-ImageCandidateBinding $selection $source.path '' ''}
Refuse {Get-ImageCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') ''}
Refuse {Get-ImageCandidateBinding $selection $source.path '' $sha}
Refuse {Get-ImageCandidateBinding ([pscustomobject]@{candidate=$false}) $source.path (Join-Path $root 'feature-composition.json') $sha}
Pass {if($null-ne(Get-ImageCandidateBinding ([pscustomobject]@{candidate=$false}) '' '' '')){throw 'Canonical dispatch changed.'}}
foreach($pair in @(@('sourceInputsUnchanged',$false),@('wholeWimUnchangedDuringReadonlyVerification',$false),@('payloadReadbackSHA256','bad'),@('fontRegistrationAccepted',$true),@('guestRenderAccepted',$true))){Refuse {$f=Fixture;$f.composition.value.images[0].($pair[0])=$pair[1];Assert-ImageFeatureCandidateIdentity $selection $f.identity $source $f.composition}}
$featureFixture=Fixture
$v1=[ordered]@{version=1;kind='volterraImageCandidateV1';buildName='development-013';candidateId=$cid;artifactRoot=$root;sourceReceipt=$source.path;sourceReceiptSHA256=$sha;sourceCommit=$source.value.commit;baseArtifactRoot=(Join-Path $workspace 'build/development-006');baseImageReceiptSHA256=$sha;baseBootSHA256=$sha;baseInstallSHA256=$sha;privateDevelopmentOnly=$true;publicDistributionAllowed=$false;bootAccepted=$false;runtimeAccepted=$false;recoveryAccepted=$false;physicalHardwareAccepted=$false}|ConvertTo-Json|ConvertFrom-Json
$fixture=[pscustomobject]@{identity=[pscustomobject]@{value=$v1;SHA256=$sha};composition=$featureFixture.composition}
Pass {$b=Get-ImageCandidateBinding $selection $source.path '' '';if($b.identity.version-ne1){throw 'Legacy candidate dispatch changed.'}}
Refuse {Get-ImageCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha}
$fixture=$featureFixture
function Parse-Draft([string]$Name){$t=$null;$e=$null;$p=Join-Path $PSScriptRoot $Name;$a=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e);if($e.Count){throw 'Public proposal syntax failed.'};return $a}
foreach($name in @('Image-Candidate.ps1','Refresh-HelperImage.ps1','Finalize-ImagePayload.ps1','Build-Iso.ps1')){Pass {$null=Parse-Draft $name}}
$refresh=Parse-Draft 'Refresh-HelperImage.ps1';$refreshText=$refresh.Extent.Text
$firstTry=@($refresh.FindAll({param($n)$n-is[Management.Automation.Language.TryStatementAst]-and$n.Extent.Text.StartsWith('try {')},$true)|Sort-Object {$_.Extent.StartOffset}|Select-Object -First 1)[0]
$admission=@($refresh.FindAll({param($n)$n-is[Management.Automation.Language.IfStatementAst]-and$n.Extent.Text.StartsWith('if($featureRequested)')-and$n.Extent.StartOffset-lt$firstTry.Extent.StartOffset},$true));if($admission.Count-ne1){throw 'Exact pre-mutation feature refresh admission required.'}
function Test-Path([string]$LiteralPath){return ($LiteralPath-ceq$root)}
Pass {$featureRequested=$true;$basis='development-006';$candidateBinding=$null;$build=$root;$SourceReceipt=$source.path;$FeatureCompositionReceipt=Join-Path $root 'feature-composition.json';$ExpectedFeatureCompositionSHA256=$sha;.([scriptblock]::Create($admission[0].Extent.Text));if($basis-cne'official predefined WPF composition'-or$candidateBinding.identity.version-ne2){throw 'Actual existing-v2 branch did not admit separately collected inputs.'}}
Refuse {$featureRequested=$false;$build=$root;.([scriptblock]::Create($admission[0].Extent.Text))}
Refuse {$featureRequested=$true;$build=$root;$SourceReceipt=$source.path;$FeatureCompositionReceipt=Join-Path $root 'feature-composition.json';$ExpectedFeatureCompositionSHA256='B'*64;.([scriptblock]::Create($admission[0].Extent.Text))}
foreach($name in @('Refresh-HelperImage.ps1','Build-Iso.ps1')){Pass {$a=Parse-Draft $name;$calls=@($a.FindAll({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.InvocationOperator-eq[Management.Automation.Language.TokenKind]::Ampersand-and$n.Extent.Text.Contains('Finalize-ImagePayload.ps1')},$true));if($calls.Count-ne1){throw 'One nested Finalize call required.'};$t=$a.Extent.Text;if(-not$t.Contains('$nested.FeatureCompositionReceipt=$FeatureCompositionReceipt;$nested.ExpectedFeatureCompositionSHA256=$ExpectedFeatureCompositionSHA256')){throw 'Nested Finalize must propagate both exact v2 authority values.'}}}
$iso=Parse-Draft 'Build-Iso.ps1';$isoText=$iso.Extent.Text
$selector=@($iso.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left-is[Management.Automation.Language.VariableExpressionAst]-and$n.Left.VariablePath.UserPath-ceq'resultRelative'},$true));if($selector.Count-ne1){throw 'One actual servicing authority selector required.'}
Pass {$featureCandidate=$true;.([scriptblock]::Create($selector[0].Extent.Text));if($resultRelative-cne'feature-composition.json'){throw 'V2 cannot require fabricated006 output result.'}}
Pass {$featureCandidate=$false;.([scriptblock]::Create($selector[0].Extent.Text));if($resultRelative-cne'output/result.json'){throw 'Legacy servicing authority changed.'}}
$final=Parse-Draft 'Finalize-ImagePayload.ps1';$ftext=$final.Extent.Text
Pass {if($ftext.IndexOf('Assert-ImageCandidateBaseInputs $selection $candidateBinding')-gt$ftext.IndexOf("Dism ('final-mount-")){throw 'Whole initial receipt/WIM checks must precede mounting.'};if(-not$ftext.Contains('Existing finalized image or ISO proof forbids re-servicing this build.')){throw 'Immutable guards changed.'}}
Pass {if(-not$isoText.Contains('$sealedInputs[$resultRelative]=(FileHash $resultPath)')-or-not$isoText.Contains('sourceApplicationOverlayPerformed-isnot[bool]')-or-not$isoText.Contains('factsOverlayPerformed-isnot[bool]')){throw 'ISO must seal the selected actual authority and successful overlay facts.'}}
Pass {if($refreshText.Contains('-RebuildFoundation')-or$isoText.Contains('current-media.json')-or$ftext.Contains('current-media.json')){throw 'Consumer patch cannot rebuild006 or promote a pointer.'}}
foreach($name in @('Refresh-HelperImage.ps1','Build-Iso.ps1')){
 $a=Parse-Draft $name;$n=@($a.FindAll({param($node)$node-is[Management.Automation.Language.IfStatementAst]-and($node.Extent.Text.StartsWith('if($featureRequested){$nested.')-or$node.Extent.Text.StartsWith('if($candidateBinding-and'))-and$node.Extent.Text.Contains('$nested.FeatureCompositionReceipt=$FeatureCompositionReceipt;')},$true));if($n.Count-ne1){throw 'One exact nested feature argument assignment required.'}
 Pass {$featureRequested=$true;$candidateBinding=Get-ImageCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;$nested=@{BuildName='development-013';SourceReceipt=$source.path;CandidateDirectory=$root};$FeatureCompositionReceipt=Join-Path $root 'feature-composition.json';$ExpectedFeatureCompositionSHA256=$sha;.([scriptblock]::Create($n[0].Extent.Text));if($nested.FeatureCompositionReceipt-cne$FeatureCompositionReceipt-or$nested.ExpectedFeatureCompositionSHA256-cne$sha-or$nested.Count-ne5){throw 'Actual nested call lost or broadened v2 arguments.'}}
 Pass {$featureRequested=$false;$candidateBinding=$null;$nested=@{BuildName='development-013';SourceReceipt=$source.path};.([scriptblock]::Create($n[0].Extent.Text));if($nested.Count-ne2){throw 'Canonical nested arguments changed.'}}
}
$gate=@($iso.FindAll({param($node)$node-is[Management.Automation.Language.IfStatementAst]-and$node.Extent.Text.StartsWith('if($featureCandidate){')-and$node.Extent.Text.Contains('The measured v2 composition authority changed.')},$true));if($gate.Count-ne1){throw 'One exact v2 ISO authority/overlay gate required.'}
function FileHash([string]$Path){if($Path-cne(Join-Path $root 'feature-composition.json')){throw 'Mock hash only permits exact composition receipt.'};return $script:isoAuthoritySHA}
$isoAuthoritySHA=$sha;$candidateBinding=Get-ImageCandidateBinding $selection $source.path (Join-Path $root 'feature-composition.json') $sha;$resultPath=Join-Path $root 'feature-composition.json'
Pass {$featureCandidate=$true;$receipt=[pscustomobject]@{featureCompositionSHA256=$sha;sourceApplicationOverlayPerformed=$true;factsOverlayPerformed=$true};$finalSource=$receipt;.([scriptblock]::Create($gate[0].Extent.Text))}
Refuse {$featureCandidate=$true;$receipt=[pscustomobject]@{featureCompositionSHA256=$sha;sourceApplicationOverlayPerformed=$true;factsOverlayPerformed=$false};$finalSource=$receipt;.([scriptblock]::Create($gate[0].Extent.Text))}
Refuse {$featureCandidate=$true;$isoAuthoritySHA='B'*64;try{.([scriptblock]::Create($gate[0].Extent.Text))}finally{$isoAuthoritySHA=$sha}}
Pass {$featureCandidate=$false;$result=[pscustomobject]@{status='passed';build='development-006'};.([scriptblock]::Create($gate[0].Extent.Text))}
Refuse {$featureCandidate=$false;$result=[pscustomobject]@{status='passed';build='development-013'};.([scriptblock]::Create($gate[0].Extent.Text))}
Write-Output "$passed actual v1/v2 dispatch, authority, initial-byte, refresh and nested-consumer fixtures passed; no builder/native/media/candidate operation."
