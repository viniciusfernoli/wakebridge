$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $projectDir '.tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$releases = Invoke-RestMethod 'https://go.dev/dl/?mode=json'
$release = $releases | Where-Object stable | Select-Object -First 1
$archive = $release.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' } | Select-Object -First 1
if (-not $archive) { throw 'No stable Go Windows archive found' }
$archivePath = Join-Path $toolsDir $archive.filename
if (-not (Test-Path -LiteralPath $archivePath)) { Invoke-WebRequest ('https://go.dev/dl/' + $archive.filename) -OutFile $archivePath }
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archive.sha256) { throw 'Go checksum mismatch' }
if (-not (Test-Path -LiteralPath (Join-Path $toolsDir 'go\bin\go.exe'))) { Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDir }
& (Join-Path $toolsDir 'go\bin\go.exe') version
