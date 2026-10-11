#Requires -RunAsAdministrator
[CmdletBinding()]
param([ValidatePattern('^development-[0-9]{3}$')][string]$BuildName='development-006')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $workspace ('build\'+$BuildName)
$media = Join-Path $build 'iso-media'
$isoName = if ($BuildName -eq 'development-006') { 'Microsoft-Volterra-development-arm64.iso' } else { 'Microsoft-Volterra-'+$BuildName+'-arm64.iso' }
$iso = Join-Path $build $isoName
$adk = 'C:\Program Files (x86)\Windows Kits\10\Assessment and Deployment Kit\Deployment Tools'
function Save($Name,$Object) { $Object | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $build $Name) -Encoding utf8 }
function Bcd([string[]]$Arguments) {
    $result = & "$env:SystemRoot\System32\bcdedit.exe" @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Private media BCD operation failed: $result" }
    return ($result -join [Environment]::NewLine)
}
try {
    $finalized = Join-Path $build 'Finalize-result.json'
    if (-not (Test-Path -LiteralPath $finalized)) { & (Join-Path $PSScriptRoot 'Finalize-ImagePayload.ps1') -BuildName $BuildName }
    if ((Get-Content -LiteralPath $finalized -Raw | ConvertFrom-Json).status -ne 'passed') { throw 'Final helper payload has not been verified.' }
    $result = Get-Content -LiteralPath (Join-Path $build 'output\result.json') -Raw | ConvertFrom-Json
    $receipt = Get-Content -LiteralPath (Join-Path $build 'image-receipt.json') -Raw | ConvertFrom-Json
    if ($result.status -ne 'passed' -or $result.build -ne 'development-006') { throw 'Successful VM servicing is required.' }
    if ((Get-FileHash -LiteralPath (Join-Path $build 'output\boot.wim')).Hash -ne $receipt.bootSHA256 -or (Get-FileHash -LiteralPath (Join-Path $build 'output\install.wim')).Hash -ne $receipt.installSHA256) { throw 'Captured image hashes changed.' }
    if ((Test-Path -LiteralPath $media) -or (Test-Path -LiteralPath $iso)) { throw 'Existing media will not be overwritten.' }
    foreach ($folder in @('sources','boot','efi\boot','efi\Microsoft\Boot\Fonts')) { New-Item -ItemType Directory -Path (Join-Path $media $folder) -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $build 'output\boot.wim') -Destination (Join-Path $media 'sources\boot.wim')
    Copy-Item -LiteralPath (Join-Path $build 'output\install.wim') -Destination (Join-Path $media 'sources\install.wim')
    Copy-Item -LiteralPath "$env:SystemRoot\Boot\DVD\EFI\boot.sdi" -Destination (Join-Path $media 'boot\boot.sdi')
    Copy-Item -LiteralPath "$env:SystemRoot\Boot\EFI\bootmgfw.efi" -Destination (Join-Path $media 'efi\boot\bootaa64.efi')
    Copy-Item -LiteralPath "$env:SystemRoot\Boot\EFI\bootmgfw.efi" -Destination (Join-Path $media 'efi\Microsoft\Boot\bootmgfw.efi')
    Copy-Item -LiteralPath "$env:SystemRoot\Boot\EFI\bootmgr.efi" -Destination (Join-Path $media 'bootmgr.efi')
    Get-ChildItem -LiteralPath "$env:SystemRoot\Boot\Fonts" -File | Copy-Item -Destination (Join-Path $media 'efi\Microsoft\Boot\Fonts')
    Copy-Item -LiteralPath 'D:\license.rtf' -Destination (Join-Path $media 'Microsoft-Validation-OS-license.rtf')
    $store = Join-Path $media 'efi\Microsoft\Boot\BCD'
    $entry = '{f5fdc9b1-9f54-4c48-a69f-c801c7e5cc31}'
    Bcd @('/createstore',$store) | Out-Null
    Bcd @('/store',$store,'/create','{bootmgr}','/d','Microsoft Volterra development media') | Out-Null
    Bcd @('/store',$store,'/set','{bootmgr}','device','boot') | Out-Null
    Bcd @('/store',$store,'/create','{ramdiskoptions}','/d','Microsoft Volterra RAM disk') | Out-Null
    Bcd @('/store',$store,'/set','{ramdiskoptions}','ramdisksdidevice','boot') | Out-Null
    Bcd @('/store',$store,'/set','{ramdiskoptions}','ramdisksdipath','\boot\boot.sdi') | Out-Null
    Bcd @('/store',$store,'/create',$entry,'/d','Microsoft Volterra','/application','osloader') | Out-Null
    foreach ($property in @('device','osdevice')) { Bcd @('/store',$store,'/set',$entry,$property,'ramdisk=[boot]\sources\boot.wim,{ramdiskoptions}') | Out-Null }
    Bcd @('/store',$store,'/set',$entry,'path','\Windows\System32\winload.efi') | Out-Null
    Bcd @('/store',$store,'/set',$entry,'systemroot','\Windows') | Out-Null
    Bcd @('/store',$store,'/set',$entry,'winpe','yes') | Out-Null
    Bcd @('/store',$store,'/set',$entry,'detecthal','yes') | Out-Null
    Bcd @('/store',$store,'/default',$entry) | Out-Null
    Bcd @('/store',$store,'/displayorder',$entry) | Out-Null
    Bcd @('/store',$store,'/timeout','0') | Out-Null
    Bcd @('/store',$store,'/enum','all','/v') | Set-Content -LiteralPath (Join-Path $build 'iso-bcd.txt')
    Copy-Item -LiteralPath $store -Destination (Join-Path $media 'boot\BCD')
    $efi = Join-Path $adk 'arm64\Oscdimg\efisys_noprompt.bin'
    & (Join-Path $adk 'arm64\Oscdimg\oscdimg.exe') -m -o -u2 -udfver102 -lVOLTERRA_ARM64 "-bootdata:1#pEF,e,b$efi" $media $iso > (Join-Path $build 'iso-output.txt')
    if ($LASTEXITCODE -ne 0) { throw "ISO creation failed ($LASTEXITCODE)." }
    Save 'iso-receipt.json' @{ path=$iso; sha256=(Get-FileHash -LiteralPath $iso).Hash; bytes=(Get-Item -LiteralPath $iso).Length; architecture='arm64'; bootTested=$false; privateDevelopmentOnly=$true }
    Save 'Iso-result.json' @{ status='passed' }
} catch { Save 'Iso-result.json' @{ status='failed'; error=$_.Exception.Message }; exit 1 }
