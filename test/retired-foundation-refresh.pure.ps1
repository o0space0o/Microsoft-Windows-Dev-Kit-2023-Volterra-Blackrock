$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Actual production guard and AST fixtures only; no script entrypoint/native IO.
$scripts=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../scripts'))
$path=Join-Path $scripts 'Refresh-HelperImage.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Refresh source parse failed.'}
$source=[IO.File]::ReadAllText($path)
$assignment=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left-is[Management.Automation.Language.VariableExpressionAst]-and$n.Left.VariablePath.UserPath-ceq'featureRequested'},$true))
$refusal=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.IfStatementAst]-and$n.Extent.Text.StartsWith('if(-not$featureRequested)')},$true))
if($assignment.Count-ne1-or$refusal.Count-ne1){throw 'One actual early feature guard is required.'}
$guard=[scriptblock]::Create('param([string]$FeatureCompositionReceipt,[string]$ExpectedFeatureCompositionSHA256)'+[Environment]::NewLine+$assignment[0].Extent.Text+[Environment]::NewLine+$refusal[0].Extent.Text+[Environment]::NewLine+'$true')
$passed=0
function Pass([scriptblock]$Body){&$Body;$script:passed++}
function Refuses([string]$Receipt,[string]$Hash){
 $caught=$false
 try{&$guard $Receipt $Hash|Out-Null}catch{if($_.Exception.Message-cne'Legacy development-006 image creation is retired. A reviewed WPF composition is required.'){throw};$caught=$true}
 if(-not$caught){throw 'Unbound legacy creation reached bootstrap.'}
}
foreach($pair in @(@($null,$null),@('',''),@($null,''),@('',$null))){Pass{Refuses $pair[0] $pair[1]}}
foreach($pair in @(@('C:\fixture\feature-composition.json',''),@('',('A'*64)),@('C:\fixture\feature-composition.json',('A'*64)))){Pass{if((&$guard $pair[0] $pair[1])-ne$true){throw 'Feature input should continue to the separate sealed-v2 prerequisite.'}}}
Pass{
 $workspaceAssignment=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left-is[Management.Automation.Language.VariableExpressionAst]-and$n.Left.VariablePath.UserPath-ceq'workspace'},$true))[0]
 $bootstrap=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.InvocationOperator-eq[Management.Automation.Language.TokenKind]::Dot},$true))[0]
 if($refusal[0].Extent.StartOffset-ge$workspaceAssignment.Extent.StartOffset-or$refusal[0].Extent.StartOffset-ge$bootstrap.Extent.StartOffset){throw 'Legacy refusal must precede bootstrap and workspace/base access.'}
}
Pass{
 $commands=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.CommandAst]},$true)|ForEach-Object{$_.GetCommandName()})
 foreach($name in @('New-ImageCandidateBinding','Copy-ImageCandidateInput','Copy-Item','New-Item')){if($commands-contains$name){throw 'Retired foundation clone/create path remains.'}}
 if($source.Contains("build\development-006")-or$source.Contains('$baseReceiptSHA256')){throw 'A live 006 base path remains.'}
}
Pass{
 foreach($text in @('Get-ImageCandidateBinding $selection $SourceReceipt $FeatureCompositionReceipt $ExpectedFeatureCompositionSHA256 $ApplicationOverlayAuthority $ExpectedApplicationOverlayAuthoritySHA256','Assert-ImageCandidateBaseInputs $selection $candidateBinding','$candidateBinding.identity.version-ne2','$nested.FeatureCompositionReceipt=$FeatureCompositionReceipt;$nested.ExpectedFeatureCompositionSHA256=$ExpectedFeatureCompositionSHA256','$nested.ApplicationOverlayAuthority=$ApplicationOverlayAuthority;$nested.ExpectedApplicationOverlayAuthoritySHA256=$ExpectedApplicationOverlayAuthoritySHA256')){if(-not$source.Contains($text)){throw 'Measured composition/overlay binding or nested authority changed.'}}
}
Pass{
 foreach($name in @('Build-Technician.ps1','Run-ImageBuild.ps1')){if([IO.File]::Exists((Join-Path $scripts $name))){throw 'Retired explicit 006 creator entrypoint is present.'}}
}
[pscustomobject]@{passed=$passed;operatorInvoked=$false;nativeOrVMCalls=$false;filesCreatedCopiedOrDeleted=$false}|ConvertTo-Json -Compress
