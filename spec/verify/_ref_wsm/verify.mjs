#!/usr/bin/env node
// Verificação de tarefas para Orquestrador, Operários e Testers (SPEC.md seção 6).
//
//   node spec/verify/verify.mjs list
//   node spec/verify/verify.mjs <Txx> --role operario|tester [--base <git-ref>] [--strict-scope] [--skip-commands]
//   node spec/verify/verify.mjs wave <n>
//
// Exit 0 = aprovado, 1 = reprovado, 2 = uso incorreto.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS, FORBIDDEN, TESTER_FORBIDDEN, SHARED_PATHS, IGNORED_PATHS } from './tasks.mjs'

const SPEC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(SPEC_DIR, '..')
const REPORTS = join(SPEC_DIR, 'reports')

const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m' }
  : { ok: '', fail: '', warn: '', dim: '', b: '', r: '' }

// ---------- utilidades ----------

const toPosix = (p) => p.split('\\').join('/')

function globToRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if ('.+?^${}()|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  // "apps/api/src/routes/sessions*" também cobre o diretório "sessions/..."
  return new RegExp(`^${re}(/.*)?$`)
}

const matchesAny = (file, globs) => globs.some((g) => globToRegex(g).test(file))

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.turbo') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(toPosix(relative(ROOT, full)))
  }
  return out
}

// Limita os forks do vitest: o default (1 por núcleo = 16 aqui) esgota a memória da máquina de dev.
// Idem para `pnpm -r`: um pacote por vez (tsc/vitest em paralelo em 4 pacotes esgotava o commit).
const CHILD_ENV = {
  ...process.env,
  VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '4',
  npm_config_workspace_concurrency: process.env.npm_config_workspace_concurrency ?? '1',
  // 127.0.0.1 e não localhost: as portas do compose só ouvem em IPv4 local, e o libpq no Windows
  // perde ~2 s por conexão tentando ::1 primeiro (diagnóstico do Cinzel, regressão final do T08).
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/wsm',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
}

function run(cmd, { quiet = false } = {}) {
  const started = Date.now()
  const res = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: CHILD_ENV })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (!quiet && res.status !== 0) process.stdout.write(C.dim + output.split('\n').slice(-40).join('\n') + C.r + '\n')
  return { cmd, code: res.status ?? 1, ms: Date.now() - started, tail: output.split('\n').slice(-40).join('\n') }
}

class Report {
  constructor(task, role) {
    this.task = task
    this.role = role
    this.checks = []
  }
  add(name, status, detail = '') {
    this.checks.push({ name, status, detail })
    const icon = status === 'pass' ? `${C.ok}✔` : status === 'warn' ? `${C.warn}!` : status === 'skip' ? `${C.dim}-` : `${C.fail}✘`
    console.log(`  ${icon} ${name}${C.r}${detail ? `${C.dim} — ${detail}${C.r}` : ''}`)
  }
  get ok() {
    return this.checks.every((c) => c.status !== 'fail')
  }
  save() {
    mkdirSync(REPORTS, { recursive: true })
    const file = join(REPORTS, `${this.task}-${this.role}.json`)
    writeFileSync(file, JSON.stringify({ task: this.task, role: this.role, ok: this.ok, at: new Date().toISOString(), checks: this.checks }, null, 2))
    return toPosix(relative(ROOT, file))
  }
}

// ---------- checks ----------

function checkFiles(report, files, label) {
  for (const f of files) {
    report.add(`${label}: ${f}`, existsSync(join(ROOT, f)) ? 'pass' : 'fail', existsSync(join(ROOT, f)) ? '' : 'não encontrado')
  }
}

function checkCommands(report, commands) {
  for (const cmd of commands) {
    const r = run(cmd)
    report.add(`cmd: ${cmd}`, r.code === 0 ? 'pass' : 'fail', `${r.code === 0 ? 'ok' : `exit ${r.code}`} em ${(r.ms / 1000).toFixed(1)}s`)
    if (r.code !== 0) report.checks.at(-1).output = r.tail
  }
}

function checkForbidden(report, rules) {
  const files = walk(ROOT)
  for (const rule of rules) {
    const hits = []
    for (const f of files) {
      if (!rule.exts.includes(extname(f))) continue
      if (!matchesAny(f, rule.include) || matchesAny(f, rule.exclude)) continue
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n')
      lines.forEach((line, i) => rule.regex.test(line) && hits.push(`${f}:${i + 1}`))
    }
    report.add(`regra ${rule.id}`, hits.length ? 'fail' : 'pass', hits.length ? `${rule.message} → ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5})` : ''}` : '')
  }
}

function changedFiles(base) {
  if (run('git rev-parse --is-inside-work-tree', { quiet: true }).code !== 0) return null
  const diffRef = base ?? 'HEAD'
  const diff = spawnSync(`git diff --name-only ${diffRef}`, { cwd: ROOT, shell: true, encoding: 'utf8' })
  if (diff.status !== 0) return null
  const untracked = spawnSync('git ls-files --others --exclude-standard', { cwd: ROOT, shell: true, encoding: 'utf8' })
  return [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].map((s) => s.trim()).filter(Boolean))]
}

function checkScope(report, allowed, forbidden, { base, strict }) {
  const changed = changedFiles(base)
  if (!changed) {
    report.add('escopo de arquivos', 'skip', 'sem git ou ref inválida')
    return
  }
  const relevant = changed.filter((f) => !matchesAny(f, IGNORED_PATHS))
  const bad = relevant.filter((f) => !matchesAny(f, allowed) || matchesAny(f, forbidden))
  // Em working tree compartilhada, arquivos de outras tarefas aparecem no diff: só vira erro com --base/--strict-scope.
  const status = bad.length === 0 ? 'pass' : base || strict ? 'fail' : 'warn'
  report.add('escopo de arquivos', status, bad.length ? `fora do escopo: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` (+${bad.length - 8})` : ''}` : `${relevant.length} arquivo(s) alterado(s)`)
}

function acceptanceIds(taskId) {
  const spec = readFileSync(join(SPEC_DIR, 'SPEC.md'), 'utf8')
  const ids = [...spec.matchAll(new RegExp(`\\*\\*(AC-${taskId}-\\d{2})\\*\\*`, 'g'))].map((m) => m[1])
  return [...new Set(ids)]
}

function startInfra(report, task) {
  if (!task.infra) return
  // Máquina sem Docker daemon: usa Postgres/Redis nativos (spec/INFRA.md).
  const local = process.env.WSM_INFRA === 'local' || (process.env.WSM_INFRA !== 'docker' && run('docker info', { quiet: true }).code !== 0)
  if (local) {
    if (task.infra === 'full') {
      report.add('infra: docker compose up -d --wait', 'fail', 'sem Docker daemon nesta máquina (spec/INFRA.md)')
      return
    }
    const r = run(`node "${join(SPEC_DIR, 'verify', 'infra-local.mjs')}"`)
    report.add('infra: local (postgres:5432, redis:6379)', r.code === 0 ? 'pass' : 'fail', r.code === 0 ? '' : r.tail.slice(-200))
    return
  }
  const cmd = task.infra === 'full' ? 'docker compose up -d --wait' : 'docker compose up -d --wait postgres redis'
  const r = run(cmd)
  report.add(`infra: ${cmd}`, r.code === 0 ? 'pass' : 'fail', r.code === 0 ? '' : `exit ${r.code}`)
}

function checkAcceptance(report, task) {
  const ids = acceptanceIds(task.id)
  if (!ids.length) {
    report.add('critérios na SPEC', 'fail', `nenhum AC-${task.id}-nn encontrado em SPEC.md`)
    return
  }
  report.add('critérios na SPEC', 'pass', ids.join(', '))

  const dir = `tests/acceptance/${task.id}`
  const testFiles = walk(join(ROOT, dir)).filter((f) => /\.test\.tsx?$/.test(f))
  if (!testFiles.length) {
    report.add('arquivos de teste', 'fail', `nenhum *.test.ts em ${dir}/`)
    return
  }
  report.add('arquivos de teste', 'pass', `${testFiles.length} arquivo(s)`)

  const source = testFiles.map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n')
  const missing = ids.filter((id) => !source.includes(id))
  report.add('todo AC referenciado em teste', missing.length ? 'fail' : 'pass', missing.length ? `sem teste: ${missing.join(', ')}` : '')

  startInfra(report, task)

  const out = join(REPORTS, `${task.id}-vitest.json`)
  mkdirSync(REPORTS, { recursive: true })
  if (existsSync(out)) rmSync(out)
  const config = existsSync(join(ROOT, 'tests/acceptance/vitest.config.ts')) ? '--config tests/acceptance/vitest.config.ts ' : ''
  const r = run(`pnpm exec vitest run ${config}--reporter=json --outputFile="${out}" ${dir}`)
  if (!existsSync(out)) {
    report.add('execução vitest', 'fail', `sem relatório JSON (exit ${r.code})`)
    report.checks.at(-1).output = r.tail
    return
  }
  const json = JSON.parse(readFileSync(out, 'utf8'))
  const results = (json.testResults ?? []).flatMap((f) => f.assertionResults ?? [])
  report.add('execução vitest', r.code === 0 ? 'pass' : 'fail', `${json.numPassedTests ?? 0} passed, ${json.numFailedTests ?? 0} failed, ${(json.numPendingTests ?? 0) + (json.numTodoTests ?? 0)} skipped/todo`)

  for (const id of ids) {
    const mine = results.filter((t) => (t.fullName ?? t.title ?? '').includes(id))
    const passed = mine.filter((t) => t.status === 'passed').length
    const failed = mine.filter((t) => t.status === 'failed')
    const skipped = mine.filter((t) => t.status !== 'passed' && t.status !== 'failed').length
    const status = mine.length && passed && !failed.length && !skipped ? 'pass' : 'fail'
    const detail = !mine.length
      ? 'nenhum teste executado com este ID'
      : `${passed} passed${failed.length ? `, ${failed.length} failed: ${failed.map((t) => t.title).join(' | ').slice(0, 200)}` : ''}${skipped ? `, ${skipped} skipped` : ''}`
    report.add(id, status, detail)
    if (failed.length) report.checks.at(-1).failures = failed.map((t) => ({ title: t.fullName, messages: t.failureMessages }))
  }
}

// ---------- papéis ----------

function verifyOperario(task, opts) {
  const report = new Report(task.id, 'operario')
  console.log(`\n${C.b}${task.id} — ${task.title} · OPERÁRIO${C.r}`)
  const unmet = depsUnmet(task)
  if (unmet.length) report.add('dependências aceitas', 'warn', `sem relatório aprovado: ${unmet.join(', ')}`)
  checkFiles(report, task.requiredFiles, 'arquivo')
  if (opts.skipCommands) report.add('comandos', 'skip', '--skip-commands')
  else checkCommands(report, task.commands)
  checkForbidden(report, FORBIDDEN)
  checkScope(report, [...task.paths, ...SHARED_PATHS], ['tests/acceptance/**'], opts)
  return report
}

function verifyTester(task, opts) {
  const report = new Report(task.id, 'tester')
  console.log(`\n${C.b}${task.id} — ${task.title} · TESTER${C.r}`)
  if (task.testerRequiredFiles) checkFiles(report, task.testerRequiredFiles, 'arquivo')
  checkForbidden(report, TESTER_FORBIDDEN)
  checkAcceptance(report, task)
  checkScope(report, ['tests/**'], [], opts)
  return report
}

function depsUnmet(task) {
  return task.deps.filter((d) =>
    ['operario', 'tester'].some((role) => {
      const f = join(REPORTS, `${d}-${role}.json`)
      return !existsSync(f) || !JSON.parse(readFileSync(f, 'utf8')).ok
    }),
  )
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--role') opts.role = argv[++i]
    else if (a === '--base') opts.base = argv[++i]
    else if (a === '--strict-scope') opts.strict = true
    else if (a === '--skip-commands') opts.skipCommands = true
    else opts.positional.push(a)
  }
  return opts
}

function usage() {
  console.log(`Uso:
  node spec/verify/verify.mjs list
  node spec/verify/verify.mjs <Txx> --role operario|tester [--base <git-ref>] [--strict-scope] [--skip-commands]
  node spec/verify/verify.mjs wave <n>`)
  process.exit(2)
}

function list() {
  console.log(`${C.b}Onda  Tarefa  Status (op/test)   Título${C.r}`)
  for (const t of [...TASKS].sort((a, b) => a.wave - b.wave)) {
    const st = ['operario', 'tester'].map((role) => {
      const f = join(REPORTS, `${t.id}-${role}.json`)
      if (!existsSync(f)) return '·'
      return JSON.parse(readFileSync(f, 'utf8')).ok ? `${C.ok}ok${C.r}` : `${C.fail}x${C.r}`
    })
    const acs = acceptanceIds(t.id).length
    console.log(`  ${t.wave}    ${t.id}    ${st.join('/').padEnd(18)} ${t.title} ${C.dim}(${acs} ACs; deps: ${t.deps.join(', ') || '—'})${C.r}`)
  }
}

const opts = parseArgs(process.argv.slice(2))
const [cmd, arg] = opts.positional

if (!cmd) usage()
if (cmd === 'list') {
  list()
  process.exit(0)
}

if (cmd === 'wave') {
  const n = Number(arg)
  if (Number.isNaN(n)) usage()
  const reports = []
  for (const t of TASKS.filter((t) => t.wave <= n)) {
    reports.push(verifyOperario(t, { ...opts, base: undefined }), verifyTester(t, { ...opts, base: undefined }))
    reports.at(-2).save()
    reports.at(-1).save()
  }
  const failed = reports.filter((r) => !r.ok)
  console.log(`\n${failed.length ? C.fail + 'REPROVADO' : C.ok + 'APROVADO'}${C.r} — onda ≤ ${n}: ${reports.length - failed.length}/${reports.length} verificações ok`)
  failed.forEach((r) => console.log(`  ✘ ${r.task} ${r.role}`))
  process.exit(failed.length ? 1 : 0)
}

const task = TASKS.find((t) => t.id === cmd.toUpperCase())
if (!task || !['operario', 'tester'].includes(opts.role)) usage()

const report = opts.role === 'operario' ? verifyOperario(task, opts) : verifyTester(task, opts)
const file = report.save()
console.log(`\n${report.ok ? C.ok + 'APROVADO' : C.fail + 'REPROVADO'}${C.r} — ${task.id} ${opts.role} · relatório: ${file}`)
process.exit(report.ok ? 0 : 1)
