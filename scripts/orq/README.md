# scripts/orq — orquestração da obra

Rodar sempre a partir do checkout da main (`leonas-crm/scripts/orq`). Temporários em `.orq-tmp/` (gitignored).

| Script | Uso |
|---|---|
| `integrate-batch.sh T1 T2 …` | **gate em lote** (2+ tarefas aprovadas): monta `batch/<ts>` sobre a main (integrate.sh em modo lote: `ORQ_TARGET`, `ORQ_NO_VERIFY`), roda `verify.mjs batch` UMA vez no worktree da última (união dos comandos, suíte completa, dependentes, aceitação de cada tarefa; repete 1x só o que falhou) e faz ff da main. Reprovado: desmonta e passa cada tarefa pelo gate individual (as boas entram, a culpada volta ao operário). Uma tarefa só → integrate.sh. |
| `integrate.sh Txx "Título"` | gate: commit no worktree, rebase em main, verify sobre main, ff-merge, remove o worktree. Roda de uma cópia em `.orq-tmp/`. |
| `watch.mjs [s]` | vigia (background): sai com ALERTA quando um agente cai, trava em diálogo, fica parado ou um verify passa de 40 min. Grava `.orq-tmp/heartbeat`. Segurados de propósito: `.orq-tmp/hold.txt`. |
| `orq-check.ps1 alive\|dead\|stalled` | pre-run das rotinas do Maestri (estado em `~/.maestri/orq-guard`). |
| `orq-register.ps1 -Session <id>` | registra o terminal/sessão do orquestrador para as rotinas. Rodar ao assumir a orquestração. |
| `dispatch.mjs <base> Txx:Op:Tester…` | prompts de despacho (JSON para `maestri ask --batch`). |
| `ready.mjs "<merged csv>" "<busy csv>"` | tarefas com dependências integradas, por altura. |
| `union.mjs <arquivos>` | resolve conflitos aditivos de registro durante o rebase. |
| `obra.mjs` + `obra-times.mjs` | atualizam o painel "Obra do Leonas CRM". |
| `verify-age.ps1`, `rm-worktree.ps1` | auxiliares. |

Remoto: `origin` (GitHub, privado). O `integrate.sh` faz `git push origin main` depois de cada gate aprovado; falha só gera aviso (`.orq-tmp/push.log`). Depois de um commit de STATUS, rode `git push -q origin main` (também sem bloquear). Nunca envie `task/*`.

## Política de gate (2026-10-16, força total)
- 2+ tarefas aprovadas (operário e tester DONE) → `bash scripts/orq/integrate-batch.sh T1 T2 …`; tarefa única sem outra em ~5 min → `integrate.sh`.
- Entre gates: `powershell -File scripts/orq/harness-orphans.ps1 -Kill`.
- **Migrations:** o operário gera a migration normalmente (precisa dela nos testes); o número pode colidir com outra tarefa. O gate (integrate.sh, também no lote) detecta o conflito no journal, regenera a migration da tarefa sobre a main/lote com o mesmo nome e só segue se o conjunto de comandos SQL for igual ao original. Não reservamos números no brief: a ordem real dos merges não é conhecida no despacho.
