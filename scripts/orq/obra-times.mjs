// pós-processo do obra.mjs: acrescenta dispatch/mergeAt por tarefa (usados pela seção "previsão" do painel)
// uso: node obra-times.mjs <html>
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../..', import.meta.url)).split('\\').join('/')
const file = process.argv[2]
const html = fs.readFileSync(file, 'utf8')
const m = /const SNAPSHOT = (\{.*\});?\s*$/m.exec(html)
const snap = JSON.parse(m[1])
const merges = execSync(`git -C "${root}" log --reverse --format=%h%x09%cI%x09%s`, { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('\t')).filter(([, , s]) => /^T\d+: /.test(s))
const mergeAt = {}
for (const [, at, s] of merges) { const id = s.split(':')[0]; mergeAt[id] ??= Date.parse(at) }
const dispatchAt = {}
try { for (const f of fs.readdirSync(root + '.git/logs/refs/heads/task')) { const l = fs.readFileSync(root + '.git/logs/refs/heads/task/' + f, 'utf8').split('\n')[0]; const r = /> (\d+) [-+]\d{4}\t/.exec(l); if (r) dispatchAt[f] = +r[1] * 1000 } } catch {}
for (const t of snap.tasks) { t.dispatch = dispatchAt[t.id] ?? t.dispatch ?? null; t.mergeAt = mergeAt[t.id] ?? null }
fs.writeFileSync(file, html.replace(m[1], JSON.stringify(snap)))
console.log('tempos:', snap.tasks.filter((t) => t.mergeAt).length, 'merges,', snap.tasks.filter((t) => t.dispatch).length, 'despachos')
