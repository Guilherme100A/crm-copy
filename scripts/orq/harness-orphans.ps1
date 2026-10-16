# Lista (ou encerra, com -Kill) processos node.exe de worktrees que já não existem (lixo do harness/verify de tarefas integradas).
param([switch]$Kill)
$wtRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\leonas-crm-wt')).Path
$live = @(Get-ChildItem $wtRoot -Directory | ForEach-Object Name)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'leonas-crm-wt[\/](T\d+)[\/]' -and $live -notcontains $Matches[1]) {
    '{0} {1} {2}MB' -f $_.ProcessId, $Matches[1], [int]($_.WorkingSetSize / 1MB)
    if ($Kill) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}
