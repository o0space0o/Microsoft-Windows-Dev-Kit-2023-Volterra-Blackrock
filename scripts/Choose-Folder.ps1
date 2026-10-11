$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a persistent project folder for Codex'
$dialog.ShowNewFolderButton = $true
try { if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath } }
finally { $dialog.Dispose() }
