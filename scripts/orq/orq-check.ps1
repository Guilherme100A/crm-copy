# Estado do orquestrador para as rotinas do Maestri (pre-run): exit 0 se estiver no estado pedido.
#   alive   = o shell do terminal do orquestrador tem um claude.exe filho
#   dead    = o terminal existe mas o claude.exe saiu (rotina "Ressuscitar orquestrador")
#   stalled = vivo, mas o heartbeat do watch.mjs está velho (> 20 min): ninguém está atendendo a obra
# Estado em ~/.maestri/orq-guard: shell.pid e session.txt (gravados por orq-register.ps1); log.txt.
param([ValidateSet('alive', 'dead', 'stalled')][string]$Want = 'alive', [int]$StallMin = 20)
$dir = Join-Path $env:USERPROFILE '.maestri\orq-guard'
$log = Join-Path $dir 'log.txt'
$shellPid = [int](Get-Content (Join-Path $dir 'shell.pid') -ErrorAction Stop)
if (-not (Get-CimInstance Win32_Process -Filter "ProcessId=$shellPid")) { Write-Output 'terminal do orquestrador fechado'; exit 1 }
$alive = [bool](Get-CimInstance Win32_Process -Filter "ParentProcessId=$shellPid AND Name='claude.exe'")
$hb = Join-Path $PSScriptRoot '..\..\.orq-tmp\heartbeat'
$age = if (Test-Path $hb) { [int]((Get-Date) - (Get-Item $hb).LastWriteTime).TotalMinutes } else { 9999 }
$state = if (-not $alive) { 'MORTO' } elseif ($age -gt $StallMin) { "TRAVADO (heartbeat $age min)" } else { 'vivo' }
Add-Content $log "$(Get-Date -f s) $Want -> $state" -ErrorAction SilentlyContinue
Write-Output $state
switch ($Want) {
  'alive' { if ($alive) { exit 0 } else { exit 1 } }
  'dead' { if (-not $alive) { exit 0 } else { exit 1 } }
  'stalled' { if ($alive -and $age -gt $StallMin) { exit 0 } else { exit 1 } }
}
