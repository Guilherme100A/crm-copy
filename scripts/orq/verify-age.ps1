# Lista os verifies em execução: "<Txx> <minutos>" por linha (usado pelo watch.mjs)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'verify\.mjs (T\d+)' } |
  ForEach-Object { '{0} {1}' -f $Matches[1], [int]((Get-Date) - $_.CreationDate).TotalMinutes }
