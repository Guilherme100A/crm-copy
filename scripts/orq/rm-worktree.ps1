param([Parameter(Mandatory)][string]$Task)
# Remove a pasta de um worktree já integrado (node_modules do pnpm passa do MAX_PATH no Windows).
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\leonas-crm-wt')).Path
$p = "\?\$root\$Task"
if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
