// uso: node dispatch.mjs <base> T01:Op:Tester ...  → imprime JSON para maestri ask --batch
import { fileURLToPath } from 'node:url'
const [base, ...pairs] = process.argv.slice(2)
const { TASKS } = await import(new URL('../../spec/verify/tasks.mjs', import.meta.url))
const list = Array.isArray(TASKS) ? TASKS : Object.values(TASKS)
const out = {}
for (const p of pairs) {
  const [id, op, ts] = p.split(':')
  const title = list.find((t) => t.id === id)?.title ?? id
  const wt = fileURLToPath(new URL(`../../../leonas-crm-wt/${id}`, import.meta.url)).split('\\').join('/')
  out[op] = `Você é OPERÁRIO na tarefa ${id} — ${title}. Worktree: ${wt} (branch task/${id}). Trabalhe só nele (cd para ele em todo comando). Rode pnpm install no worktree primeiro. Leia spec/SPEC.md: seções 1, 2.3, 2.4, 3 e a tarefa ${id} inteira; leia as seções de feature citadas em "Ref". Antes de usar qualquer API de biblioteca: confira spec/STACK.md (versões exatas e notas verificadas); depois o context7 nessa versão; se o context7 estiver sem cota, confira no código e nos tipos (.d.ts) instalados em node_modules — nunca pela memória. Escreva SOMENTE dentro dos Paths da tarefa e, de forma aditiva, nos arquivos compartilhados (SPEC 2.4). Não toque em tests/**. Implemente os entregáveis e atenda a todos os critérios AC-${id}-nn. Escreva testes unitários. Antes de reportar: node spec/verify/verify.mjs ${id} --role operario --base ${base} (exit 0 obrigatório). Não faça commit. Reporte com: maestri ask "Claude Code" "<relatório no formato da seção 2.3>" e confirme que o comando retornou sem erro (se falhar, tente de novo). Dúvida de requisito → BLOCKED com a pergunta. Seu Tester nesta tarefa é "${ts}".`
  out[ts] = `Você é TESTER na tarefa ${id} — ${title}. Worktree: ${wt}. Escreva só em tests/acceptance/${id}/ (e helpers em tests/acceptance/helpers, de forma aditiva). Leia spec/SPEC.md: seções 1, 2.3, 3 (3.10 e 3.11) e a tarefa ${id} inteira. Um ou mais testes por critério; o título de cada teste DEVE conter o ID (ex.: it('AC-${id}-01 ...')). Teste pelos contratos (HTTP, portas públicas, comandos), não por detalhes internos. Nunca WhatsApp real nem API paga: use os fakes. Não edite apps/** nem packages/**. Não faça commit. Escreva os testes já e reporte que estão prontos; se precisar que o Operário exponha algo, diga no relatório. Quando eu avisar que a implementação terminou, rode: node spec/verify/verify.mjs ${id} --role tester --base ${base}. Reporte com: maestri ask "Claude Code" "<relatório no formato da seção 2.3>" e confirme que o comando retornou sem erro. Bug de produto → REJECT com ID do AC, esperado e obtido. Seu Operário nesta tarefa é "${op}".`
}
process.stdout.write(JSON.stringify(out))
