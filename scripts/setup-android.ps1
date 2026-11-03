$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$toolDir = Join-Path $projectDir '.tools'
$sdkDir = Join-Path $toolDir 'android-sdk'
$archivePath = Join-Path $toolDir 'commandlinetools-win-15859902_latest.zip'
New-Item -ItemType Directory -Force -Path $sdkDir | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) { Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' -OutFile $archivePath }
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a') { throw 'Android CLI checksum mismatch' }
$cliDir = Join-Path $sdkDir 'cmdline-tools\latest'
if (-not (Test-Path -LiteralPath $cliDir)) {
  $unpackDir = Join-Path $toolDir 'android-cli-unpack'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $unpackDir -Force
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cliDir) | Out-Null
  Move-Item -LiteralPath (Join-Path $unpackDir 'cmdline-tools') -Destination $cliDir
}
$javaExecutable = (Get-Command javac -ErrorAction Stop).Source
$jdkCandidates = @(Get-ChildItem -LiteralPath 'C:\Program Files\Java' -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\javac.exe') })
if ($jdkCandidates.Count -gt 0) { $env:JAVA_HOME = $jdkCandidates[-1].FullName }
$manager = Join-Path $cliDir 'bin\sdkmanager.bat'
1..100 | ForEach-Object { 'y' } | & $manager "--sdk_root=$sdkDir" 'platforms;android-37.0' 'build-tools;36.0.0' 'platform-tools' *> (Join-Path $toolDir 'android-sdk-setup.log')
if ($LASTEXITCODE -ne 0) { throw 'SDK packages failed' }
$gradleVersion = '9.6.0'
$gradleZip = Join-Path $toolDir "gradle-$gradleVersion-bin.zip"
if (-not (Test-Path -LiteralPath $gradleZip)) { Invoke-WebRequest "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $gradleZip }
$expectedHash = (Invoke-RestMethod "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip.sha256").Trim()
if ((Get-FileHash -LiteralPath $gradleZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Gradle checksum mismatch' }
if (-not (Test-Path -LiteralPath (Join-Path $toolDir "gradle-$gradleVersion"))) { Expand-Archive -LiteralPath $gradleZip -DestinationPath $toolDir }
Write-Output "SDK ready at $sdkDir; Gradle $gradleVersion verified."
