param([Parameter(Mandatory=$true)][string]$Server,[switch]$EnableLanRelay)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Execute este instalador em um PowerShell como administrador.' }
if (Get-Service -Name WakeBridge -ErrorAction SilentlyContinue) { throw 'WakeBridge já está instalado. Desinstale o serviço antes de reinstalar.' }
$installDir = Join-Path $env:ProgramFiles 'WakeBridge'
$dataDir = Join-Path $env:ProgramData 'WakeBridge'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$binary = Join-Path $installDir 'wakebridge.exe'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'wakebridge.exe') -Destination $binary
$pairArguments = @('pair','--server',$Server,'--service','--config-dir',$dataDir)
if ($EnableLanRelay) { $pairArguments += '--lan' }
& $binary @pairArguments
if ($LASTEXITCODE -ne 0) { throw 'Pareamento falhou. Serviço não instalado.' }
& $binary install --config-dir $dataDir
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar o serviço.' }
if ($EnableLanRelay) {
  try {
    if (-not (Get-NetFirewallRule -Name 'WakeBridge-Discovery' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name 'WakeBridge-Discovery' -DisplayName 'WakeBridge authenticated LAN discovery' -Program $binary -Service WakeBridge -Direction Inbound -Action Allow -Protocol UDP -LocalPort 34780 -RemoteAddress LocalSubnet -Profile Private,Domain | Out-Null
    }
  } catch { Write-Warning 'Não foi possível autorizar a descoberta UDP no firewall. O inventário continuará funcionando; valide a regra local antes de testar descoberta.' }
}
Start-Service -Name WakeBridge
Get-Service -Name WakeBridge
