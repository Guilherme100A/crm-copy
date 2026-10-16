// uso (dentro de um rebase com conflito): node union.mjs <arquivo>...
// Resolve conflitos de pontos de registro aditivos (SPEC 2.4):
//  - *.ts/*.tsx: união das linhas dos dois lados (main primeiro), sem duplicatas;
//  - package.json: merge ESTRUTURAL das versões :2: (main) e :3: (tarefa) — exports/deps por chave
//    (divergência fica com main), entradas do tsup no script build unidas.
// Sai com 1 se algum arquivo precisar de resolução manual.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MARK = /<<<<<<< [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g
const stage = (n, file) => JSON.parse(execFileSync('git', ['show', `:${n}:${file}`]).toString())
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x === '.' ? -1 : y === '.' ? 1 : x.localeCompare(y))))
const tsupEntries = (s = '') => s.match(/src\/[\w/.-]+\.tsx?/g) ?? []

function mergePackageJson(file) {
  const main = stage(2, file), task = stage(3, file), out = { ...task, ...main }
  for (const k of ['exports', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!main[k] && !task[k]) continue
    for (const [key, val] of Object.entries(task[k] ?? {}))
      if (main[k]?.[key] !== undefined && JSON.stringify(main[k][key]) !== JSON.stringify(val)) console.log(`aviso ${file}: ${k}.${key} diverge; mantido main`)
    out[k] = sortKeys({ ...(task[k] ?? {}), ...(main[k] ?? {}) })
  }
  out.scripts = { ...(task.scripts ?? {}), ...(main.scripts ?? {}) }
  const mb = main.scripts?.build, tb = task.scripts?.build
  if (mb && tb && /tsup /.test(mb)) {
    const all = [...new Set([...tsupEntries(mb), ...tsupEntries(tb)])]
    out.scripts.build = mb.replace(/tsup( src\/[\w/.-]+\.tsx?)+/, `tsup ${all.join(' ')}`)
  }
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
}

let manual = false
for (const file of process.argv.slice(2)) {
  if (/(^|\/)package\.json$/.test(file)) {
    try { mergePackageJson(file); console.log(`merge estrutural: ${file}`) } catch (e) { console.log(`manual: ${file} (${e.message})`); manual = true }
    continue
  }
  // helpers de teste não são pontos de registro: união por linha os corromperia
  if (!/\.(ts|tsx)$/.test(file) || file.startsWith('tests/')) { console.log(`manual: ${file}`); manual = true; continue }
  // Merge de INSERÇÃO em 3 vias: a tarefa (:3:) deve ser a base (:1:) + blocos inseridos (sem remover linhas).
  // Cada bloco inserido entra em main (:2:) logo após a mesma linha-âncora da base. Não depende dos hunks do git
  // (que deixam linhas finais comuns, como '),' e '}', fora do conflito).
  const show = (n) => { try { return execFileSync('git', ['show', `:${n}:${file}`]).toString() } catch { return null } }
  const base = show(1), main = show(2), task = show(3)
  if (base === null || main === null || task === null) { console.log(`manual: ${file} (sem estágios 1/2/3)`); manual = true; continue }
  const B = base.split('\n'), M = main.split('\n'), Tk = task.split('\n')
  // alinha base em task: cada linha da base deve aparecer em ordem; o que sobra em task são inserções
  const inserts = [] // { afterBaseIdx, lines }
  let bi = 0, cur = null
  for (const line of Tk) {
    if (bi < B.length && line === B[bi]) { if (cur) { inserts.push(cur); cur = null } bi++ }
    else { if (!cur) cur = { afterBaseIdx: bi - 1, lines: [] }; cur.lines.push(line) }
  }
  if (cur) inserts.push(cur)
  if (bi < B.length) { console.log(`manual: ${file} (a tarefa removeu/alterou linhas da base)`); manual = true; continue }
  // aplica em main de trás para frente; âncora = linha da base logo antes da inserção, achada em main
  const out = [...M]
  for (const ins of inserts.reverse()) {
    const anchor = ins.afterBaseIdx >= 0 ? B[ins.afterBaseIdx] : null
    const nextBase = B[ins.afterBaseIdx + 1]
    // insere antes da próxima linha da base (ex.: o fechamento do catálogo), procurando de trás para frente em main
    let at = nextBase !== undefined ? out.lastIndexOf(nextBase) : out.length
    if (at < 0 && anchor !== null) at = out.lastIndexOf(anchor) + 1
    if (at < 0) { console.log(`manual: ${file} (âncora não encontrada em main)`); manual = true; break }
    out.splice(at, 0, ...ins.lines.filter((l) => l.trim() !== 'export {}'))
  }
  if (manual) continue
  const lines = out
  // imports de UMA linha que ficaram DEPOIS do início do código real (1ª declaração de nível de arquivo) sobem para
  // logo antes dela. Imports multilinha (`import {` … `} from`) nunca são tocados.
  const codeStart = lines.findIndex((l) => /^(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\b/.test(l))
  const oneLineImport = (l) => /^import\s.*\bfrom\s+['"][^'"]+['"];?\s*$|^import\s+['"][^'"]+['"];?\s*$/.test(l)
  const stray = codeStart < 0 ? [] : lines.map((l, i) => (i > codeStart && oneLineImport(l) ? i : -1)).filter((i) => i >= 0)
  const moved = stray.reverse().map((i) => lines.splice(i, 1)[0]).reverse()
  if (moved.length) lines.splice(codeStart, 0, ...moved)
  const top = codeStart
  writeFileSync(file, lines.join('\n'))
  console.log(`união: ${file}${stray.length ? ` (${stray.length} import(s) movido(s) para o topo)` : ''}`)
}
process.exit(manual ? 1 : 0)
