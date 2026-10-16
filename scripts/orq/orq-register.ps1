# Registra o terminal e a sessão do orquestrador para as rotinas (rodar de dentro da sessão do orquestrador).
# uso: powershell -File scripts/orq/orq-register.ps1 -Session <id da sessão do Claude Code>
param([Parameter(Mandatory)][string]$Session)
$dir = Join-Path $env:USERPROFILE '.maestri\orq-guard'
New-Item -ItemType Directory -Force $dir | Out-Null
# sobe a árvore de processos até o claude.exe; o pai dele é o shell do terminal no Maestri
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
while ($p -and $p.Name -ne 'claude.exe') { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
if (-not $p) { throw 'claude.exe não encontrado entre os ancestrais' }
Set-Content (Join-Path $dir 'shell.pid') $p.ParentProcessId
Set-Content (Join-Path $dir 'session.txt') $Session
"shell=$($p.ParentProcessId) claude=$($p.ProcessId) session=$Session"
