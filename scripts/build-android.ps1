param([switch]$Release)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$env:ANDROID_HOME = Join-Path $projectDir '.tools\android-sdk'
$env:GRADLE_USER_HOME = Join-Path $projectDir '.tools\gradle-cache'
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
  $javaProperties = & java -XshowSettings:properties -version 2>&1
  $javaHomeLine = $javaProperties | Select-String '^\s*java.home\s*=' | Select-Object -First 1
  if (-not $javaHomeLine) { throw 'Configure JAVA_HOME to a JDK 21 installation.' }
  $env:JAVA_HOME = ($javaHomeLine.Line -split '=',2)[1].Trim()
}
$gradle = Join-Path $projectDir '.tools\gradle-9.6.0\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradle)) { throw 'Run scripts/setup-android.ps1 first.' }
if ($Release -and -not $env:WAKEBRIDGE_KEYSTORE) { throw 'Set WAKEBRIDGE_KEYSTORE, WAKEBRIDGE_STORE_PASSWORD, WAKEBRIDGE_KEY_ALIAS and WAKEBRIDGE_KEY_PASSWORD for signed release.' }
Push-Location (Join-Path $projectDir 'apps\agent-android')
try {
  $variant = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
  & $gradle --no-daemon testDebugUnitTest lintDebug $variant
  if ($LASTEXITCODE -ne 0) { throw 'Android checks/build failed.' }
  $source = if ($Release) { 'app\build\outputs\apk\release\app-release.apk' } else { 'app\build\outputs\apk\debug\app-debug.apk' }
  $outDir = Join-Path $projectDir '.local\android'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Copy-Item -LiteralPath $source -Destination $outDir
  if (-not $Release) {
    $downloads=Join-Path $projectDir 'apps\web\public\downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $downloads 'wakebridge-android-debug.apk')
  }
  Get-FileHash -LiteralPath (Join-Path $outDir (Split-Path -Leaf $source)) -Algorithm SHA256
} finally { Pop-Location }
