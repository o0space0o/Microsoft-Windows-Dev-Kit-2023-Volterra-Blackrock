[CmdletBinding()]
param([int]$Port=43123)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $taskRoot 'private\tools'
$result = @{ status='running'; edition=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID; architecture=$env:PROCESSOR_ARCHITECTURE; systemRoot=$env:SystemDrive+'\'; versions=@{}; utc=[DateTime]::UtcNow.ToString('o') }
$output = Join-Path $env:VOLTERRA_STATE_DIR 'boot-runtime.json'
function Save { $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $output -Encoding utf8 }
try {
    New-Item -ItemType Directory -Path $env:VOLTERRA_STATE_DIR -Force | Out-Null
    Save
    foreach ($name in @('node','codex','gh','git')) {
        $exe = if ($name -eq 'git') { Join-Path $tools 'git\cmd\git.exe' } else { Join-Path $tools ($name+'.exe') }
        $version = & $exe --version
        if ($LASTEXITCODE -ne 0) { throw "$name could not run in this OS ($LASTEXITCODE)." }
        $result.versions[$name] = ($version -join ' ')
    }
    $result.codexProtocol = (& (Join-Path $tools 'node.exe') (Join-Path $PSScriptRoot 'Probe-Runtime.mjs') | ConvertFrom-Json)
    if (-not $result.codexProtocol.appServerInitialized) { throw 'The Codex protocol did not initialize.' }
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
        try {
            $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -SessionVariable localSession
            $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -WebSession $localSession
            if ($state.project.path -ne $result.systemRoot) { throw 'The system workspace was not selected automatically.' }
            $result.automaticWorkspace = $state.project.path
            $result.serverReady = $true
            break
        } catch { if ([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Seconds 3 }
    } while ($true)
    $result.browserRunning = [bool](Get-Process -Name chrome -ErrorAction SilentlyContinue)
    if (-not $result.browserRunning) { throw 'The helper browser did not start.' }
    $result.status = 'passed'
    $updater = Join-Path $tools '..\bootstrap\Apply-SourceUpdate.mjs'
    $confirmation = & (Join-Path $tools 'node.exe') $updater $env:VOLTERRA_STATE_DIR $taskRoot confirm (Join-Path $tools 'git\cmd\git.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Source update health confirmation failed.' }
    $result.sourceUpdate = ($confirmation | ConvertFrom-Json)
} catch { $result.status='failed'; $result.error=$_.Exception.Message }
finally { $result.utc=[DateTime]::UtcNow.ToString('o'); Save }
