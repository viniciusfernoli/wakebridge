param([switch]$PurgeCredentials)
$ErrorActionPreference = 'Stop'
$installDir = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WakeBridge'))
$dataDir = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'WakeBridge'))
if ($installDir -ne ([IO.Path]::GetFullPath($env:ProgramFiles).TrimEnd('\') + '\WakeBridge')) { throw 'Diretório de instalação inválido.' }
if ($dataDir -ne ([IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\') + '\WakeBridge')) { throw 'Diretório de dados inválido.' }
$binary = Join-Path $installDir 'wakebridge.exe'
Get-NetFirewallRule -Name 'WakeBridge-Discovery' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if (Get-Service -Name WakeBridge -ErrorAction SilentlyContinue) {
  & $binary uninstall
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao desinstalar o serviço. Use um PowerShell como administrador.' }
}
if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
if ($PurgeCredentials -and (Test-Path -LiteralPath $dataDir)) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
Write-Output 'Serviço removido. Revogue também a credencial no dashboard. O inventário do servidor permanece salvo.'
