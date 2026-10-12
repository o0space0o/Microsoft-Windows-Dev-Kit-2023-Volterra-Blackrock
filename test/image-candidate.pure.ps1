$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$scripts=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
. (Join-Path $scripts 'Image-Candidate.ps1')
$script:passed=0
function Check([bool]$Value,[string]$Message){if(-not$Value){throw $Message};$script:passed++}
function Refuse([scriptblock]$Action){$refused=$false;try{& $Action | Out-Null}catch{$refused=$true};Check $refused ('Required refusal did not occur: '+$Action.ToString())}
$workspace='C:\workspace'
$uuid='11111111-2222-3333-4444-555555555555'
$candidate=Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid)
$selection=Get-ImageBuildSelection $workspace 'development-013' $candidate $true
Check ($selection.build-ceq$candidate-and$selection.candidateId-ceq$uuid-and$selection.candidate) 'Exact candidate selection differs.'
foreach($name in @('development-006','development-013')){ $normal=Get-ImageBuildSelection $workspace $name $null $false;Check (-not$normal.candidate-and$normal.build-ceq(Join-Path $workspace ('build/'+$name))) 'Original canonical selection changed.' }
foreach($name in @('development-006','development-014','development-01','../Windows','')){Refuse {Get-ImageBuildSelection $workspace $name $candidate $true}}
foreach($pathValue in @('', ' ','.\build\verification\media-candidate-development-013-'+$uuid, '\\server\share\media-candidate-development-013-'+$uuid, (Join-Path $workspace 'build/development-013'), (Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid+'/child')), (Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid+'/')), (Join-Path $workspace ('build/verification/../verification/media-candidate-development-013-'+$uuid)), (Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid+'.')), (Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid+' ')), (Join-Path $workspace 'build/verification/media-candidate-development-013-AAAAAAAA-2222-3333-4444-555555555555'), (Join-Path $workspace 'build/verification/media-candidate-development-013-00000000-0000-0000-0000-000000000000'), (Join-Path $workspace ('build/verification/media-candidate-development-014-'+$uuid)), (Join-Path $workspace ('build/verification/media-candidate-development-013-'+$uuid+':stream')), ('C:\workspace-other\build\verification\media-candidate-development-013-'+$uuid))){Refuse {Get-ImageBuildSelection $workspace 'development-013' $pathValue $true}}
Refuse {Get-ImageCandidateSource '' $workspace}
Assert-ImageCandidatePathLength ('C:\'+('a'*256));Check $true '259-character file boundary refused.'
Refuse {Assert-ImageCandidatePathLength ('C:\'+('a'*257))}
Assert-ImageCandidatePathLength ('C:\'+('a'*244)) -Directory;Check $true '247-character directory boundary refused.'
Refuse {Assert-ImageCandidatePathLength ('C:\'+('a'*245)) -Directory}
$longWorkspace='C:\'+('w'*130);Refuse {Get-ImageBuildSelection $longWorkspace 'development-013' (Join-Path $longWorkspace ('build/verification/media-candidate-development-013-'+$uuid)) $true}
$source=[pscustomobject]@{path=(Join-Path $workspace 'build/source-snapshots/fixture/source-receipt.json');SHA256=('A'*64);value=([pscustomobject]@{version=1;checksPassed=$true;commit=('1'*40);files=[pscustomobject]@{'app/server.mjs'=('2'*64)}})}
$value=[pscustomobject][ordered]@{version=1;kind='volterraImageCandidateV1';candidateId=$uuid;buildName='development-013';artifactRoot=$candidate;sourceReceipt=$source.path;sourceReceiptSHA256=$source.SHA256;sourceCommit=$source.value.commit;baseArtifactRoot=(Join-Path $workspace 'build/development-006');baseImageReceiptSHA256=('B'*64);baseBootSHA256=('C'*64);baseInstallSHA256=('D'*64);privateDevelopmentOnly=$true;publicDistributionAllowed=$false;bootAccepted=$false;runtimeAccepted=$false;recoveryAccepted=$false;physicalHardwareAccepted=$false}
$record=[pscustomobject]@{value=$value;SHA256=('E'*64)}
Assert-ImageCandidateIdentity $selection $record $source;Check $true 'Valid identity rejected.'
foreach($mutation in @(@('version','1'),@('version',2),@('kind','other'),@('candidateId','22222222-2222-3333-4444-555555555555'),@('buildName','development-014'),@('artifactRoot',(Join-Path $workspace 'build/development-013')),@('sourceReceipt','C:\foreign\source-receipt.json'),@('sourceReceiptSHA256',('F'*64)),@('sourceCommit',('3'*40)),@('baseArtifactRoot','C:\foreign\development-006'),@('baseBootSHA256','main'),@('baseInstallSHA256',('d'*64)),@('privateDevelopmentOnly',$false),@('publicDistributionAllowed',$true),@('bootAccepted',$true),@('runtimeAccepted',$true),@('recoveryAccepted',$true),@('physicalHardwareAccepted',$true),@('bootAccepted','false'))){
 $changed=$value | ConvertTo-Json -Depth 6 | ConvertFrom-Json;$changed.($mutation[0])=$mutation[1]
 Refuse {Assert-ImageCandidateIdentity $selection ([pscustomobject]@{value=$changed}) $source}
}
function Read-ImageCandidateFile([string]$Path,[string]$Root){return $script:mockSource}
$script:mockSource=$source
Check ((Get-ImageCandidateSource $source.path $workspace).SHA256-ceq$source.SHA256) 'Actual JSON source shape rejected.'
foreach($mutation in @(@('checksPassed','true'),@('checksPassed',$false),@('version','1'),@('commit','main'),@('files',@()))){
 $changed=$source.value | ConvertTo-Json -Depth 6 | ConvertFrom-Json;$changed.($mutation[0])=$mutation[1]
 $script:mockSource=[pscustomobject]@{path=$source.path;SHA256=$source.SHA256;value=$changed};Refuse {Get-ImageCandidateSource $source.path $workspace}
}
$script:baseRecord=[pscustomobject]@{SHA256=$value.baseImageReceiptSHA256;value=[pscustomobject]@{bootSHA256=$value.baseBootSHA256;installSHA256=$value.baseInstallSHA256}}
$script:wimHashes=@{boot=$value.baseBootSHA256;install=$value.baseInstallSHA256}
function Read-ImageCandidateFile([string]$Path,[string]$Root){return $script:baseRecord}
function Assert-ImageCandidatePath([string]$Path,[string]$Root,[switch]$AllowMissing){return [IO.Path]::GetFullPath($Path)}
function Get-Item([string]$LiteralPath,[switch]$Force){return [pscustomobject]@{PSIsContainer=$false}}
function Get-FileHash([string]$LiteralPath,[string]$Algorithm){$kind=if($LiteralPath.EndsWith('boot.wim')){'boot'}else{'install'};return [pscustomobject]@{Hash=$script:wimHashes[$kind]}}
$binding=[pscustomobject]@{identity=$value};Assert-ImageCandidateBaseInputs $selection $binding;Check $true 'Actual initial base input predicate refused.'
$script:baseRecord.SHA256='F'*64;Refuse {Assert-ImageCandidateBaseInputs $selection $binding};$script:baseRecord.SHA256=$value.baseImageReceiptSHA256
foreach($kind in @('boot','install')){
 $property=$kind+'SHA256';$original=$script:baseRecord.value.$property;$script:baseRecord.value.$property='F'*64
 $script:wimHashes[$kind]='F'*64;Refuse {Assert-ImageCandidateBaseInputs $selection $binding}
 $script:baseRecord.value.$property=$original;Refuse {Assert-ImageCandidateBaseInputs $selection $binding};$script:wimHashes[$kind]=$original
}
Remove-Item Function:Get-Item;Remove-Item Function:Get-FileHash
# Exercise actual Save functions through AST extraction; no build script entrypoint executes.
function Import-Function([string]$File,[string]$Name){$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts $File),[ref]$tokens,[ref]$errors);Check (@($errors).Count-eq0) ('Parse errors in '+$File);$function=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-ceq$Name},$true);if(-not$function){throw 'Expected production function absent.'};$definition=$function.Extent.Text-replace('^function '+[regex]::Escape($Name)+'(?=[(\s])'),('function script:'+$Name);. ([scriptblock]::Create($definition));return $ast}
$script:saved=[Collections.Generic.List[object]]::new()
function Save-ImageCandidateJson([string]$Path,$Value,[string]$Root){$script:saved.Add([pscustomobject]@{path=$Path;root=$Root;value=($Value|ConvertTo-Json -Depth 10|ConvertFrom-Json)})}
$build=$candidate;$candidateBinding=[pscustomobject]@{identity=$value;identitySHA256=('E'*64);source=$source};$refreshStage=0
$refresh=Import-Function 'Refresh-HelperImage.ps1' 'Save'
Save @{status='running';phase='First'};Save @{status='running';phase='Second'};Save @{status='passed'}
Check ($saved[0].path-ceq(Join-Path $candidate 'refresh-stage-01.json')-and$saved[1].path-ceq(Join-Path $candidate 'refresh-stage-02.json')-and$saved[2].path-ceq(Join-Path $candidate 'refresh-result.json')) 'Candidate stage receipts reused a path.'
foreach($row in $saved){Check ($row.value.candidateId-ceq$uuid-and$row.value.artifactRoot-ceq$candidate-and$row.value.candidateIdentitySHA256-ceq('E'*64)) 'Candidate refresh evidence binding missing.'}
$final=Import-Function 'Finalize-ImagePayload.ps1' 'Save-Finalization';Save-Finalization @{status='passed';sourceCommit=$source.value.commit}
Check ($saved[3].path-ceq(Join-Path $candidate 'Finalize-result.json')-and$saved[3].value.sourceReceiptSHA256-ceq$source.SHA256) 'Finalization source receipt binding missing.'
$baseCall=$final.Find({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.GetCommandName()-ceq'Assert-ImageCandidateBaseInputs'},$true)
$firstMount=$final.Find({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.GetCommandName()-ceq'Dism'-and$n.Extent.Text-match'final-mount'},$true)
Check ($null-ne$baseCall-and$null-ne$firstMount-and$baseCall.Extent.StartOffset-lt$firstMount.Extent.StartOffset) 'Initial base predicate must run before first candidate mount.'
$tokens=$null;$errors=$null;$isoAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $scripts 'Build-Iso.ps1'),[ref]$tokens,[ref]$errors);Check (@($errors).Count-eq0) 'ISO script parse failure.'
foreach($pair in @(@($refresh,'Finalize-ImagePayload.ps1'),@($refresh,'Build-Iso.ps1'),@($isoAst,'Finalize-ImagePayload.ps1'))){
 $calls=@($pair[0].FindAll({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.Extent.Text.Contains($pair[1])},$true)|Where-Object{$_.Extent.Text-match'@nested'})
 Check ($calls.Count-eq1) ('Exact nested candidate call missing: '+$pair[1])
}
foreach($ast in @($refresh,$isoAst)){
 Check (@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left.Extent.Text-ceq'$nested'-and$n.Right.Extent.Text-match'BuildName=\$BuildName;SourceReceipt=\$SourceReceipt'},$true)).Count-eq1) 'Nested checked SourceReceipt propagation missing.'
 Check (@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left.Extent.Text-ceq'$nested.CandidateDirectory'-and$n.Right.Extent.Text-ceq'$build'},$true)).Count-eq1) 'Nested candidate root propagation missing.'
}
# Tiny ordinary host fixture only: no media candidate directory, WIM, mount or vendor execution.
. (Join-Path $scripts 'Image-Candidate.ps1')
$temporaryParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture=Join-Path $temporaryParent ('volterra-candidate-guard-fixture-'+[Guid]::NewGuid().ToString('D'))
if((Split-Path -Parent $fixture)-cne$temporaryParent-or[IO.Path]::GetFileName($fixture)-cnotmatch'^volterra-candidate-guard-fixture-[a-f0-9-]{36}$'){throw 'Host fixture scope differs.'}
$fixtureFile=Join-Path $fixture 'fixture.json';$newFile=Join-Path $fixture 'new.json'
$script:fixtureLink=$null;$script:fixtureProvider='FileSystem';$script:fixtureReparse=$false
function Get-Item {
 [CmdletBinding()]param([string]$LiteralPath,[switch]$Force,[string]$Stream)
 if($PSBoundParameters.ContainsKey('Stream')){return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -Stream $Stream -ErrorAction Stop}
 $actual=Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
 if($LiteralPath-ceq$fixtureFile){return [pscustomobject]@{PSProvider=[pscustomobject]@{Name=$script:fixtureProvider};Attributes=($(if($script:fixtureReparse){[IO.FileAttributes]::ReparsePoint}else{$actual.Attributes}));LinkType=$script:fixtureLink;PSIsContainer=$actual.PSIsContainer;Length=$actual.Length}}
 return $actual
}
try{
 [IO.Directory]::CreateDirectory($fixture) | Out-Null
 [IO.File]::WriteAllText($fixtureFile,'{"version":1}',[Text.UTF8Encoding]::new($false))
 Check ((Assert-ImageCandidatePath $fixtureFile $fixture)-ceq$fixtureFile) 'Ordinary host fixture rejected.'
 foreach($kind in @('HardLink','SymbolicLink','Junction')){$script:fixtureLink=$kind;Refuse {Assert-ImageCandidatePath $fixtureFile $fixture}}
 $script:fixtureLink=$null;$script:fixtureReparse=$true;Refuse {Assert-ImageCandidatePath $fixtureFile $fixture};$script:fixtureReparse=$false
 $script:fixtureProvider='Registry';Refuse {Assert-ImageCandidatePath $fixtureFile $fixture};$script:fixtureProvider='FileSystem'
 Refuse {Assert-ImageCandidatePath (Join-Path ($fixture+'-other') 'fixture.json') $fixture}
 $read=Read-ImageCandidateFile $fixtureFile $fixture;Check ($read.value.version-eq1) 'Actual bounded ordinary JSON read failed.'
 Set-Content -LiteralPath $fixtureFile -Stream 'fixture-ads' -Value 'Fixture-only stream' -NoNewline
 Refuse {Read-ImageCandidateFile $fixtureFile $fixture}
 Remove-Item -LiteralPath $fixtureFile -Stream 'fixture-ads'
 Save-ImageCandidateJson $newFile @{version=1;fixtureOnly=$true} $fixture
 $before=(Get-FileHash -LiteralPath $newFile).Hash
 Refuse {Save-ImageCandidateJson $newFile @{version=2} $fixture}
 Check ((Get-FileHash -LiteralPath $newFile).Hash-ceq$before) 'CreateNew guard altered existing evidence.'
}finally{
 Remove-Item Function:Get-Item
 foreach($file in @($newFile,$fixtureFile)){if([IO.File]::Exists($file)){[IO.File]::Delete($file)}}
 if([IO.Directory]::Exists($fixture)){[IO.Directory]::Delete($fixture,$false)}
}
Write-Output ('Image candidate pure fixtures passed: '+$passed)
