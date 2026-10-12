#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^development-[0-9]{3}$')][string]$BuildName,
    [string]$SourceReceipt,
    [string]$CandidateDirectory
)
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$base=Join-Path $workspace 'build\development-006'
. (Join-Path $PSScriptRoot 'Image-Candidate.ps1')
$selection=Get-ImageBuildSelection $workspace $BuildName $CandidateDirectory ($PSBoundParameters.ContainsKey('CandidateDirectory'))
$build=$selection.build
$candidateBinding=$null;$refreshStage=0
function Save($value) {
    if($selection.candidate){
        $value.candidateId=$selection.candidateId;$value.artifactRoot=$build;$value.sourceCommit=$candidateBinding.identity.sourceCommit;$value.candidateIdentitySHA256=$candidateBinding.identitySHA256
        $name=if($value.status-eq'running'){$script:refreshStage++;'refresh-stage-'+$script:refreshStage.ToString('00')+'.json'}else{'refresh-result.json'}
        Save-ImageCandidateJson (Join-Path $build $name) $value $build
    }else{$value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build 'refresh-result.json') -Encoding utf8}
}
if (Test-Path -LiteralPath $build) { throw 'A helper refresh build already exists and will not be overwritten.' }
try {
    $baseReceiptSHA256=(Get-FileHash -LiteralPath (Join-Path $base 'image-receipt.json')).Hash
    $receipt=Get-Content -LiteralPath (Join-Path $base 'image-receipt.json') -Raw | ConvertFrom-Json
    foreach ($kind in @('boot','install')) {
        if ((Get-FileHash -LiteralPath (Join-Path $base ('output\'+$kind+'.wim'))).Hash -ne $receipt.($kind+'SHA256')) { throw 'The sealed base image hash changed.' }
    }
    if((Get-FileHash -LiteralPath (Join-Path $base 'image-receipt.json')).Hash-cne$baseReceiptSHA256){throw 'The sealed base image receipt changed.'}
    if($selection.candidate){
        $candidateSource=Get-ImageCandidateSource $SourceReceipt $workspace
        $verified=& (Join-Path $workspace 'private/tools/node.exe') (Join-Path $PSScriptRoot 'Prepare-ImageSource.mjs') --verify $candidateSource.path
        if($LASTEXITCODE-ne0-or($verified | ConvertFrom-Json).commit-cne$candidateSource.value.commit){throw 'Candidate checked source verification failed.'}
        $SourceReceipt=$candidateSource.path
        $candidateBinding=New-ImageCandidateBinding $selection $candidateSource $baseReceiptSHA256 $receipt.bootSHA256 $receipt.installSHA256
        [IO.Directory]::CreateDirectory((Join-Path $build 'output')) | Out-Null
        foreach($file in @('boot.wim','install.wim','result.json')){
            $from=Join-Path $base ('output/'+$file);$expected=if($file-eq'boot.wim'){$receipt.bootSHA256}elseif($file-eq'install.wim'){$receipt.installSHA256}else{(Get-FileHash -LiteralPath $from).Hash}
            Copy-ImageCandidateInput $from (Join-Path $build ('output/'+$file)) $expected $workspace $build
        }
        Copy-ImageCandidateInput (Join-Path $base 'image-receipt.json') (Join-Path $build 'image-receipt.json') $candidateBinding.identity.baseImageReceiptSHA256 $workspace $build
    }else{
        New-Item -ItemType Directory -Path (Join-Path $build 'output') | Out-Null
        foreach ($file in @('boot.wim','install.wim','result.json')) { Copy-Item -LiteralPath (Join-Path $base ('output\'+$file)) -Destination (Join-Path $build 'output') }
        Copy-Item -LiteralPath (Join-Path $base 'image-receipt.json') -Destination $build
    }
    Save @{status='running';base='development-006';build=$BuildName;phase='Refreshing original helper source only'}
    $nested=@{BuildName=$BuildName;SourceReceipt=$SourceReceipt}
    if($selection.candidate){$nested.CandidateDirectory=$build}
    & (Join-Path $PSScriptRoot 'Finalize-ImagePayload.ps1') @nested
    if ($LASTEXITCODE -ne 0) { throw 'File-only helper overlay failed.' }
    Save @{status='running';base='development-006';build=$BuildName;phase='Building private ARM64 ISO'}
    & (Join-Path $PSScriptRoot 'Build-Iso.ps1') @nested
    if ($LASTEXITCODE -ne 0) { throw 'Refreshed ISO creation failed.' }
    Save @{status='passed';base='development-006';build=$BuildName;bootTested=$false;physicalTested=$false}
} catch {
    if ((Test-Path -LiteralPath $build)-and(-not$selection.candidate-or$null-ne$candidateBinding)) { Save @{status='failed';error=$_.Exception.Message} }
    else { Write-Error $_.Exception.Message }
    exit 1
}
