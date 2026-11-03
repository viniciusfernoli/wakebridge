$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$goPath = Join-Path $projectDir '.tools\go\bin\go.exe'
if (-not (Test-Path -LiteralPath $goPath)) { $goPath = (Get-Command go -ErrorAction Stop).Source }
$outputDir = Join-Path $projectDir '.local\windows'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Push-Location (Join-Path $projectDir 'agents\windows')
try {
  & $goPath test ./...
  if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
  & $goPath build -trimpath -ldflags '-s -w' -o (Join-Path $outputDir 'wakebridge.exe') ./cmd/wakebridge
  if ($LASTEXITCODE -ne 0) { throw 'Windows build failed' }
} finally { Pop-Location }
$downloadDir = Join-Path $projectDir 'apps\web\public\downloads'
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
Copy-Item -LiteralPath (Join-Path $outputDir 'wakebridge.exe') -Destination (Join-Path $downloadDir 'wakebridge.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-windows.ps1'),(Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination $outputDir
Get-FileHash -LiteralPath (Join-Path $outputDir 'wakebridge.exe') -Algorithm SHA256 | Format-List
Compress-Archive -Path (Join-Path $outputDir '*') -DestinationPath (Join-Path $projectDir '.local\wakebridge-windows-amd64.zip') -Force
