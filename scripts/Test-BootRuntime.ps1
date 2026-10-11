[CmdletBinding()]
param([int]$Port=43123)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $taskRoot 'private\tools'
$edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
$result = @{ version=2; status='running'; edition=$edition; architecture=$env:PROCESSOR_ARCHITECTURE; systemRoot=$env:SystemDrive+'\'; versions=@{}; utc=[DateTime]::UtcNow.ToString('o'); errors=@(); environment=if ($edition -eq 'WinVOS') { 'Validation OS; VM or physical device identity still needs separate evidence' } else { 'Host Windows preview' } }
$output = if ($edition -eq 'WinVOS' -and $env:VOLTERRA_STATE_DIR) { Join-Path $env:VOLTERRA_STATE_DIR 'boot-runtime.json' } else { Join-Path $taskRoot 'build\verification\boot-runtime-host.json' }
$node = Join-Path $tools 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
function Save { $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding utf8 }
function Evaluate {
    Save
    $evaluated = & $node (Join-Path $PSScriptRoot 'Check-BootEvidence.mjs') $output
    if ($LASTEXITCODE -ne 0) { throw 'The runtime evidence evaluator could not run.' }
    $script:result = $evaluated | ConvertFrom-Json
}
function Observe-Helper([int]$TimeoutMs=120000) {
    $observation = & $node (Join-Path $PSScriptRoot 'Probe-HelperRuntime.mjs') $Port $TimeoutMs
    $probeExit = $LASTEXITCODE
    $state = $observation | ConvertFrom-Json
    $result.automaticWorkspace = $state.automaticWorkspace
    $result.serverReady = $state.serverReady
    $result.helperRuntimeReady = $state.helperRuntimeReady
    $result.helperRuntimeRunning = $state.helperRuntimeRunning
    $result.helperChatgptAccountObserved = $state.helperChatgptAccountObserved
    $result.historyContext = @{ directory=$env:VOLTERRA_STATE_DIR; codexHome=$env:CODEX_HOME; sourceRoot=$taskRoot; osRoot=$result.systemRoot; bootId=$result.bootId; project=$state.project }
    if ($probeExit -ne 0) { $result.errors += $state.error }
    return $state
}
try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
    Save
    # Host inspection stops here. Never start guest tools, browser probes or
    # source-update confirmation against the current Windows installation.
    if ($edition -ne 'WinVOS') { Evaluate; return }
    if (-not $env:VOLTERRA_STATE_DIR -or -not $env:CODEX_HOME -or -not $env:VOLTERRA_OS_ROOT) { throw 'Start-Volterra.ps1 -Boot must configure OS root and persistent state before verification.' }
    $result.bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    foreach ($name in @('node','codex','gh','git')) {
        try {
            $exe = if ($name -eq 'git') { Join-Path $tools 'git\cmd\git.exe' } else { Join-Path $tools ($name+'.exe') }
            $version = & $exe --version
            if ($LASTEXITCODE -ne 0) { throw "$name could not run in this OS ($LASTEXITCODE)." }
            $result.versions[$name] = ($version -join ' ')
        } catch { $result.errors += $_.Exception.Message }
    }
    $result.versionsVerified = $result.versions.Count -eq 4
    $state = Observe-Helper
    $previousProbeThread = $env:VOLTERRA_PROBE_THREAD_ID
    try {
        $env:VOLTERRA_PROBE_THREAD_ID = $state.project.threadId
        # A nonzero exit preserves completed stages. Never configure or bypass
        # the native sandbox to turn a missing stage into successful evidence.
        $result.codexProtocol = (& $node (Join-Path $PSScriptRoot 'Probe-Runtime.mjs') | ConvertFrom-Json)
    } catch { $result.errors += $_.Exception.Message }
    finally { $env:VOLTERRA_PROBE_THREAD_ID = $previousProbeThread }
    $result.browser = @{ executableMatched=$false; helperScriptExecuted=$false; renderCaptured=$false }
    try {
        $chrome = Join-Path $tools 'chrome\chrome.exe'
        $result.browser.executableMatched = [bool](Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $chrome })
        if (-not $result.browser.executableMatched) { throw 'The staged system browser is not running.' }
        # Exercise the staged engine with a separate credential-free profile.
        $profile = Join-Path $env:VOLTERRA_STATE_DIR 'runtime-browser-probe'
        $capture = Join-Path $profile 'render.png'
        New-Item -ItemType Directory -Path $profile -Force | Out-Null
        if (Test-Path -LiteralPath $capture) { Remove-Item -LiteralPath $capture }
        $browserOutput = Join-Path $profile 'dom.txt'
        $browserError = Join-Path $profile 'error.txt'
        $browserProcess = Start-Process -FilePath $chrome -WindowStyle Hidden -PassThru -ArgumentList @('--headless=new','--no-first-run','--window-size=1672,941','--virtual-time-budget=5000','--timeout=15000',('--user-data-dir="{0}"' -f $profile),('--screenshot="{0}"' -f $capture),'--dump-dom',"http://127.0.0.1:$Port/") -RedirectStandardOutput $browserOutput -RedirectStandardError $browserError
        if (-not $browserProcess.WaitForExit(20000)) { Stop-Process -Id $browserProcess.Id; throw 'The staged browser probe timed out.' }
        if ($browserProcess.ExitCode -ne 0) { throw 'The staged browser probe failed. Private diagnostics remain in runtime-browser-probe/error.txt.' }
        $browserEvidence = & $node (Join-Path $PSScriptRoot 'Check-BrowserEvidence.mjs') $browserOutput $capture
        if ($LASTEXITCODE -ne 0) { throw 'The browser capture could not be verified.' }
        $browserEvidence = $browserEvidence | ConvertFrom-Json
        $result.browser.helperScriptExecuted = $browserEvidence.helperScriptExecuted
        $result.browser.renderCaptured = $browserEvidence.renderCaptured
    } catch { $result.errors += $_.Exception.Message }
    finally { if ($browserOutput -and (Test-Path -LiteralPath $browserOutput)) { Remove-Item -LiteralPath $browserOutput } }
    # Browser and standalone Codex probes take time. Refresh the application
    # observation so a stopped helper or changed thread cannot use stale proof.
    $state = Observe-Helper -TimeoutMs 5000
    Evaluate
    $result | Add-Member -NotePropertyName sourceUpdate -NotePropertyValue @{ status='unconfirmed'; reason='Startup health has not passed.' }
    if ($result.startupHealthy) {
        $updater = Join-Path $tools '..\bootstrap\Apply-SourceUpdate.mjs'
        $confirmation = & $node $updater $env:VOLTERRA_STATE_DIR $taskRoot confirm (Join-Path $tools 'git\cmd\git.exe')
        if ($LASTEXITCODE -ne 0) { throw 'Source update health confirmation failed.' }
        $result.sourceUpdate = ($confirmation | ConvertFrom-Json)
    }
} catch {
    $result.errors += $_.Exception.Message
    try { Evaluate } catch { $result.status='blocked' }
} finally { $result.utc=[DateTime]::UtcNow.ToString('o'); Save }
