# Amostra o commit do sistema a cada N s enquanto houver verify rodando (ou até -MaxMin); grava CSV e imprime o pico.
# uso: powershell -File scripts/orq/commit-sampler.ps1 -Out .orq-tmp/commit-<rótulo>.csv [-Every 5] [-MaxMin 40]
param([Parameter(Mandatory)][string]$Out, [int]$Every = 5, [int]$MaxMin = 40)
"at,committed_mb,free_commit_mb,free_ram_mb,verifies" | Set-Content $Out
$end = (Get-Date).AddMinutes($MaxMin); $peak = 0; $seen = $false
while ((Get-Date) -lt $end) {
  $o = Get-CimInstance Win32_OperatingSystem
  $committed = [int](($o.TotalVirtualMemorySize - $o.FreeVirtualMemory) / 1024)
  $v = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'verify\.mjs T\d+' }).Count
  "{0:s},{1},{2},{3},{4}" -f (Get-Date), $committed, [int]($o.FreeVirtualMemory / 1024), [int]($o.FreePhysicalMemory / 1024), $v | Add-Content $Out
  if ($v -gt 0) { $seen = $true; if ($committed -gt $peak) { $peak = $committed } } elseif ($seen) { break }
  Start-Sleep $Every
}
"pico de commit com verify rodando: $peak MB (limite $([int]((Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize / 1024)) MB)"
