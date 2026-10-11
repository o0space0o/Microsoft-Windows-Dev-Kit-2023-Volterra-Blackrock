param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
if ($Mode -eq 'Protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Convert]::ToBase64String($result))
} else {
    $bytes = [Convert]::FromBase64String($inputText.Trim())
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write([Text.Encoding]::UTF8.GetString($result))
}
