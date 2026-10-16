# scripts/orq — orquestração da obra

Rodar sempre a partir do checkout da main (`leonas-crm/scripts/orq`). Temporários em `.orq-tmp/` (gitignored).

| Script | Uso |
|---|---|
| `integrate.sh Txx "Título"` | gate: commit no worktree, rebase em main, verify sobre main, ff-merge, remove o worktree. Roda de uma cópia em `.orq-tmp/`. |
| `watch.mjs [s]` | vigia (background): sai com ALERTA quando um agente cai, trava em diálogo, fica parado ou um verify passa de 40 min. Grava `.orq-tmp/heartbeat`. Segurados de propósito: `.orq-tmp/hold.txt`. |
| `orq-check.ps1 alive\|dead\|stalled` | pre-run das rotinas do Maestri (estado em `~/.maestri/orq-guard`). |
| `orq-register.ps1 -Session <id>` | registra o terminal/sessão do orquestrador para as rotinas. Rodar ao assumir a orquestração. |
| `dispatch.mjs <base> Txx:Op:Tester…` | prompts de despacho (JSON para `maestri ask --batch`). |
| `ready.mjs "<merged csv>" "<busy csv>"` | tarefas com dependências integradas, por altura. |
| `union.mjs <arquivos>` | resolve conflitos aditivos de registro durante o rebase. |
| `obra.mjs` + `obra-times.mjs` | atualizam o painel "Obra do Leonas CRM". |
| `verify-age.ps1`, `rm-worktree.ps1` | auxiliares. |
