# Lista os verifies em execução: "<Txx|batch:T1,T2> <minutos>" por linha (usado pelo watch.mjs e pelos agentes)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'verify\.mjs (T\d+|batch [\w,]+)' } |
  ForEach-Object { '{0} {1}' -f ($Matches[1] -replace '^batch ', 'batch:'), [int]((Get-Date) - $_.CreationDate).TotalMinutes }
