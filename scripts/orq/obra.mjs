// Atualiza o painel "Obra do Leonas CRM": monta a foto (SNAPSHOT) a partir de spec/STATUS.md, spec/verify/tasks.mjs,
// spec/SPEC.md e do git, e a substitui no index.html do artifact. uso: node obra.mjs <entrada.html> <saida.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('../..', import.meta.url)).split('\\').join('/').replace(/\/$/, '')
const [inFile, outFile] = process.argv.slice(2)
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim()

const { TASKS } = await import(new URL('../../spec/verify/tasks.mjs', import.meta.url))
const list = Array.isArray(TASKS) ? TASKS : Object.values(TASKS)
const spec = readFileSync(`${ROOT}/spec/SPEC.md`, 'utf8')
const status = readFileSync(`${ROOT}/spec/STATUS.md`, 'utf8')

// linhas da tabela de tarefas do STATUS: | onda | Txx | título | estado | operário | tester | rejeições | notas |
const rows = new Map()
for (const line of status.split('\n')) {
  const m = line.match(/^\|\s*\d+\s*\|\s*(T\d+)\s*\|[^|]*\|\s*([A-Z_]+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*(\d+)\s*\|\s*([^|]*)\|/)
  if (m) rows.set(m[1], { state: m[2], op: m[3].trim(), te: m[4].trim(), rej: Number(m[5]), note: m[6].trim() })
}
const acCount = (id) => new Set([...spec.matchAll(new RegExp(`\\*\\*(AC-${id}-\\d{2})\\*\\*`, 'g'))].map((x) => x[1])).size

const tasks = list.map((t) => {
  const r = rows.get(t.id) ?? { state: 'TODO', op: '', te: '', rej: 0, note: '' }
  return { id: t.id, deps: t.deps ?? [], ui: Boolean(t.e2e), ac: acCount(t.id), wave: t.wave ?? 0, title: t.title, ...r }
}).sort((a, b) => a.wave - b.wave || Number(a.id.slice(1)) - Number(b.id.slice(1)))

// entregas: commits de tarefa em main ("Txx: título"), em ordem cronológica
const titleOf = Object.fromEntries(list.map((t) => [t.id, t.title]))
const merges = git('log', 'main', '--reverse', '--format=%h|%aI|%s').split('\n')
  .map((l) => l.split('|')).filter(([, , s]) => /^T\d+[a-z]?: /.test(s ?? ''))
  .map(([h, at, s]) => { const id = s.match(/^(T\d+)/)[1]; return { id, h, at, title: titleOf[id] ?? s.slice(s.indexOf(':') + 2) } })
  // uma entrega por tarefa: o último commit dela (consertos/regenerações não contam como entrega nova)
  .filter((m, i, all) => !all.slice(i + 1).some((n) => n.id === m.id))

// pendências: linhas da tabela "Pendências para tarefas futuras"
const pendSection = status.split('## Pendências para tarefas futuras')[1] ?? ''
const pendencias = pendSection.split('\n').filter((l) => /^\|\s*[^|-]/.test(l) && !/^\|\s*Tarefa\s*\|/.test(l)).length

const now = new Date()
const SNAPSHOT = {
  at: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + ' (BRT)',
  atIso: now.toISOString(),
  head: git('rev-parse', '--short', 'main'),
  headMsg: git('log', '-1', '--format=%s', 'main'),
  pendencias,
  pairs: [['Cinzel', 'Radar'], ['Torno', 'Sonda'], ['Bigorna', 'Lupa']],
  merges,
  tasks,
}

const html = readFileSync(inFile, 'utf8')
const re = /const SNAPSHOT = \{[\s\S]*?\};\n/
if (!re.test(html)) throw new Error('SNAPSHOT não encontrado no HTML')
writeFileSync(outFile, html.replace(re, () => `const SNAPSHOT = ${JSON.stringify(SNAPSHOT)};\n`))
const done = tasks.filter((t) => t.state === 'MERGED').length
console.log(`foto ${SNAPSHOT.at} · main ${SNAPSHOT.head} · ${done}/${tasks.length} na main · ${merges.length} entregas · ${pendencias} pendências`)
