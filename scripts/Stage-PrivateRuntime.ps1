[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $taskRoot 'private\tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$codex = (Get-Command codex -ErrorAction Stop).Source
Copy-Item -LiteralPath $node -Destination (Join-Path $tools 'node.exe')
$nodeLicense = Join-Path (Split-Path $node) 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense) { Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $tools 'node-LICENSE.txt') }
Get-ChildItem -LiteralPath (Split-Path $codex) -File -Filter '*.exe' | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $tools }
$git = (Get-Command git -ErrorAction Stop).Source
$gitRoot = Split-Path (Split-Path $git)
Copy-Item -LiteralPath $gitRoot -Destination (Join-Path $tools 'git') -Recurse
$chrome = 'C:\Program Files\Google\Chrome\Application'
if (Test-Path -LiteralPath $chrome) { Copy-Item -LiteralPath $chrome -Destination (Join-Path $tools 'chrome') -Recurse }
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cli/cli/releases/latest'
$asset = $release.assets | Where-Object name -Match '^gh_[0-9.]+_windows_arm64.zip$' | Select-Object -First 1
if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'The official GitHub CLI ARM64 asset or its digest is missing.' }
$downloadFolder = Join-Path $taskRoot 'build\downloads'
New-Item -ItemType Directory -Path $downloadFolder -Force | Out-Null
$archive = Join-Path $downloadFolder $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne $asset.digest.Substring(7)) { throw 'GitHub CLI download did not match the official release digest.' }
$extraction = Join-Path $downloadFolder ([IO.Path]::GetFileNameWithoutExtension($asset.name))
if (-not (Test-Path -LiteralPath $extraction)) { Expand-Archive -LiteralPath $archive -DestinationPath $extraction }
$gh = Get-ChildItem -LiteralPath $extraction -Recurse -Filter 'gh.exe' | Select-Object -First 1
if (-not $gh) { throw 'GitHub CLI was not found in the verified archive.' }
Copy-Item -LiteralPath $gh.FullName -Destination (Join-Path $tools 'gh.exe')
Get-ChildItem -LiteralPath $extraction -Recurse -Filter 'LICENSE*' -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $tools ('gh-' + $_.Name)) }
$manifest = @{
    purpose = 'Private local test image only; review licenses before any binary redistribution'
    node = (& $node --version)
    codex = (& $codex --version)
    github = @{ version = $release.tag_name; source = $asset.browser_download_url; sha256 = $hash }
    files = @(Get-ChildItem -LiteralPath $tools -File | ForEach-Object { @{ name = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash } })
}
$manifest | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $tools 'runtime-manifest.json') -Encoding utf8
Write-Output 'Private runtime binaries staged. Browser and Codex compatibility inside Validation OS still require testing.'
