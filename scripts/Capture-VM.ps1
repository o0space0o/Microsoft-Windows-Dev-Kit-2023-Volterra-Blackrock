[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][Guid]$VMId,
    [Parameter(Mandatory=$true)][string]$OutputFile,
    [Guid]$CaptureId=[Guid]::NewGuid()
)
$ErrorActionPreference = 'Stop'
try {
    $vm = Get-WmiObject -Namespace root\virtualization\v2 -Class Msvm_ComputerSystem -Filter "Name='$VMId'"
    $settings = @($vm.GetRelated('Msvm_VirtualSystemSettingData') | Where-Object VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized')[0]
    $service = Get-WmiObject -Namespace root\virtualization\v2 -Class Msvm_VirtualSystemManagementService
    $result = $service.GetVirtualSystemThumbnailImage($settings.__PATH, [uint16]1024, [uint16]768)
    if ($result.ReturnValue -ne 0) { throw "Thumbnail returned $($result.ReturnValue)." }
    $pixels = [byte[]]$result.ImageData
    if ($pixels.Length -eq 1024*768*2+4) {
        $bounded = New-Object byte[] (1024*768*2)
        [Array]::Copy($pixels,$bounded,$bounded.Length)
        $pixels = $bounded
    }
    if ($pixels.Length -ne 1024*768*2) { throw "Unexpected thumbnail byte count: $($pixels.Length)." }
    $stream = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter($stream)
    try {
        $writer.Write([byte[]]@(66,77)); $writer.Write([int](66+$pixels.Length)); $writer.Write([int]0); $writer.Write([int]66)
        $writer.Write([int]40); $writer.Write([int]1024); $writer.Write([int]-768); $writer.Write([uint16]1); $writer.Write([uint16]16)
        $writer.Write([int]3); $writer.Write([int]$pixels.Length)
        foreach ($zero in 1..4) { $writer.Write([int]0) }
        $writer.Write([int]63488); $writer.Write([int]2016); $writer.Write([int]31); $writer.Write($pixels)
        $bmpBytes = $stream.ToArray()
    } finally { $writer.Dispose(); $stream.Dispose() }
    Add-Type -AssemblyName System.Drawing
    $bmpStream = [IO.MemoryStream]::new($bmpBytes)
    $pngStream = [IO.MemoryStream]::new()
    try {
        $bitmap = [Drawing.Bitmap]::new($bmpStream)
        try { $bitmap.Save($pngStream,[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
        $payload = @{ pngBase64=[Convert]::ToBase64String($pngStream.ToArray()) } | ConvertTo-Json -Compress
    } finally { $bmpStream.Dispose(); $pngStream.Dispose() }
    $workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $node = Join-Path $workspace 'private\tools\node.exe'
    $json = $payload | & $node (Join-Path $PSScriptRoot 'Save-VM-Capture.mjs') $OutputFile ([string]$CaptureId) ([string]$VMId)
    if ($LASTEXITCODE -ne 0) { throw 'Capture output validation/publication failed.' }
    Write-Output $json
} catch { throw }
