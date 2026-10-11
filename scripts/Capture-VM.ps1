[CmdletBinding()]
param([Parameter(Mandatory=$true)][Guid]$VMId,[Parameter(Mandatory=$true)][string]$OutputFile)
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
        [IO.File]::WriteAllBytes($OutputFile+'.bmp',$stream.ToArray())
    } finally { $writer.Dispose(); $stream.Dispose() }
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object Drawing.Bitmap($OutputFile+'.bmp')
    try { $bitmap.Save($OutputFile,[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
} catch { $_.Exception.Message | Set-Content -LiteralPath ($OutputFile+'.error.txt') }
