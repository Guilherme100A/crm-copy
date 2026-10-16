#!/usr/bin/env node
// Verificação de tarefas para Orquestrador, Operários e Testers (SPEC.md seção 6).
//
//   node spec/verify/verify.mjs list                         # tarefas, ondas, deps e status dos relatórios
//   node spec/verify/verify.mjs plan [--max 4]               # lotes por onda, ordenados pelo caminho crítico
//   node spec/verify/verify.mjs lint-spec                    # SPEC.md × tasks.mjs (headings, ACs, ondas)
//   node spec/verify/verify.mjs <Txx> --role operario|tester [--base <git-ref>] [--strict-scope] [--skip-commands]
//   node spec/verify/verify.mjs wave <n>                     # regressão de todas as tarefas até a onda n
//
// Exit 0 = aprovado, 1 = reprovado, 2 = uso incorreto ou tarefa TODO.
// Node puro (sem dependências), multiplataforma.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS, FORBIDDEN, TESTER_FORBIDDEN, SHARED_PATHS, IGNORED_PATHS } from './tasks.mjs'

const SPEC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(SPEC_DIR, '..')
const REPORTS = join(SPEC_DIR, 'reports')
const REPORT_VERSION = 1
const PW_PROJECTS = ['desktop', 'mobile']

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
  // "apps/api/src/routes/chats*" também cobre o diretório "chats/..."
  return new RegExp(`^${re}(/.*)?$`)
}

const matchesAny = (file, globs) => globs.some((g) => globToRegex(g).test(file))

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.turbo', 'test-results', 'playwright-report', 'storage'].includes(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else out.push(toPosix(relative(ROOT, full)))
  }
  return out
}

// Limita forks do vitest e o paralelismo do `pnpm -r` (máquina de dev Windows com memória limitada).
// 127.0.0.1 e não localhost: no Windows o libpq perde ~2 s por conexão tentando ::1 (spec/INFRA.md).
const CHILD_ENV = {
  ...process.env,
  VITEST_MAX_WORKERS: process.env.VITEST_MAX_WORKERS ?? '4',
  npm_config_workspace_concurrency: process.env.npm_config_workspace_concurrency ?? '1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
  ANTIBAN_MODE: process.env.ANTIBAN_MODE ?? 'passthrough',
  WA_GATEWAY: process.env.WA_GATEWAY ?? 'fake',
  WA_TRANSPORT: process.env.WA_TRANSPORT ?? 'fake',
  AI_MODE: process.env.AI_MODE ?? 'fake',
  MAIL_TRANSPORT: process.env.MAIL_TRANSPORT ?? 'memory',
  APP_NAME: process.env.APP_NAME ?? 'CRM',
}

function run(cmd, { quiet = false, env = {} } = {}) {
  const started = Date.now()
  const res = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...CHILD_ENV, ...env } })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const tail = output.split('\n').slice(-40).join('\n')
  if (!quiet && res.status !== 0) process.stdout.write(C.dim + tail + C.r + '\n')
  return { cmd, code: res.status ?? 1, ms: Date.now() - started, tail }
}

function gitHead() {
  const r = spawnSync('git rev-parse HEAD', { cwd: ROOT, shell: true, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

class Report {
  constructor(task, role, opts = {}) {
    this.task = task
    this.role = role
    this.base = opts.base ?? null
    this.checks = []
    this.changedFiles = []
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
    const body = {
      version: REPORT_VERSION,
      task: this.task,
      role: this.role,
      ok: this.ok,
      at: new Date().toISOString(),
      commit: gitHead(),
      base: this.base,
      changedFiles: this.changedFiles,
      checks: this.checks,
    }
    writeFileSync(file, JSON.stringify(body, null, 2))
    return toPosix(relative(ROOT, file))
  }
}

// ---------- checks ----------

function checkFiles(report, files, label) {
  for (const f of files) {
    const ok = existsSync(join(ROOT, f))
    report.add(`${label}: ${f}`, ok ? 'pass' : 'fail', ok ? '' : 'não encontrado')
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
    report.add(`regra ${rule.id}`, hits.length ? 'fail' : 'pass',
      hits.length ? `${rule.message} → ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5})` : ''}` : '')
  }
}

function changedFiles(base) {
  if (run('git rev-parse --is-inside-work-tree', { quiet: true }).code !== 0) return null
  const diff = spawnSync(`git diff --name-only ${base ?? 'HEAD'}`, { cwd: ROOT, shell: true, encoding: 'utf8' })
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
  report.changedFiles = relevant
  const bad = relevant.filter((f) => !matchesAny(f, allowed) || matchesAny(f, forbidden))
  // Working tree compartilhada: arquivos de outras tarefas aparecem no diff → só bloqueia com --base/--strict-scope.
  const status = bad.length === 0 ? 'pass' : base || strict ? 'fail' : 'warn'
  report.add('escopo de arquivos', status,
    bad.length ? `fora do escopo: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` (+${bad.length - 8})` : ''}` : `${relevant.length} arquivo(s) alterado(s)`)
}

function readSpec() {
  const f = join(SPEC_DIR, 'SPEC.md')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

function acceptanceIds(taskId, spec = readSpec()) {
  const ids = [...spec.matchAll(new RegExp(`\\*\\*(AC-${taskId}-\\d{2})\\*\\*`, 'g'))].map((m) => m[1])
  return [...new Set(ids)]
}

function startInfra(report, task) {
  if (!task.infra) return
  const mode = process.env.CRM_INFRA ?? 'local'
  if (mode === 'docker') {
    const r = run('docker compose up -d --wait postgres redis')
    report.add('infra: docker compose (postgres, redis)', r.code === 0 ? 'pass' : 'fail', r.code === 0 ? '' : `exit ${r.code}`)
    return
  }
  // Padrão: Postgres/Redis nativos (spec/INFRA.md), sem Docker.
  const r = run(`node "${join(SPEC_DIR, 'verify', 'infra-local.mjs')}"`)
  report.add('infra: local (postgres:5432/crm, redis:6379/1)', r.code === 0 ? 'pass' : 'fail', r.code === 0 ? '' : r.tail.slice(-300))
}

// --- Vitest (tests/acceptance/Txx/**/*.test.ts) ---
function runVitest(report, task, dir, files) {
  if (!files.length) return []
  const out = join(REPORTS, `${task.id}-vitest.json`)
  if (existsSync(out)) rmSync(out)
  const config = existsSync(join(ROOT, 'tests/acceptance/vitest.config.ts')) ? '--config tests/acceptance/vitest.config.ts ' : ''
  const r = run(`pnpm exec vitest run ${config}--reporter=json --outputFile="${out}" ${dir}`)
  if (!existsSync(out)) {
    report.add('execução vitest', 'fail', `sem relatório JSON (exit ${r.code})`)
    report.checks.at(-1).output = r.tail
    return []
  }
  const json = JSON.parse(readFileSync(out, 'utf8'))
  report.add('execução vitest', r.code === 0 ? 'pass' : 'fail',
    `${json.numPassedTests ?? 0} passed, ${json.numFailedTests ?? 0} failed, ${(json.numPendingTests ?? 0) + (json.numTodoTests ?? 0)} skipped/todo`)
  return (json.testResults ?? []).flatMap((f) => f.assertionResults ?? []).map((t) => ({
    runner: 'vitest',
    project: null,
    title: t.fullName ?? t.title ?? '',
    status: t.status === 'passed' ? 'passed' : t.status === 'failed' ? 'failed' : 'skipped',
    messages: t.failureMessages ?? [],
  }))
}

// --- Playwright (tests/acceptance/Txx/**/*.e2e.ts), projetos desktop e mobile ---
function runPlaywright(report, task, dir, files) {
  if (!files.length) {
    if (task.e2e) report.add('testes E2E (Playwright)', 'fail', `tarefa de UI sem *.e2e.ts em ${dir}/`)
    return []
  }
  const config = 'tests/acceptance/playwright.config.ts'
  if (!existsSync(join(ROOT, config))) {
    report.add('execução playwright', 'fail', `${config} não encontrado (criado pelo Tester do T23)`)
    return []
  }
  const out = join(REPORTS, `${task.id}-playwright.json`)
  if (existsSync(out)) rmSync(out)
  const r = run(`pnpm exec playwright test --config ${config} --reporter=json ${dir}`, { env: { PLAYWRIGHT_JSON_OUTPUT_NAME: out } })
  if (!existsSync(out)) {
    report.add('execução playwright', 'fail', `sem relatório JSON (exit ${r.code})`)
    report.checks.at(-1).output = r.tail
    return []
  }
  const json = JSON.parse(readFileSync(out, 'utf8'))
  const rows = []
  const visit = (suite, prefix) => {
    const here = suite.title ? [...prefix, suite.title] : prefix
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = (t.results ?? []).at(-1)
        const status = t.status === 'expected' || t.status === 'flaky' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed'
        rows.push({
          runner: 'playwright',
          project: t.projectName,
          title: [...here, spec.title].join(' › '),
          status,
          messages: (last?.errors ?? []).map((e) => e.message ?? String(e)),
        })
      }
    }
    for (const s of suite.suites ?? []) visit(s, here)
  }
  for (const s of json.suites ?? []) visit(s, [])
  const st = json.stats ?? {}
  report.add('execução playwright', r.code === 0 ? 'pass' : 'fail',
    `${st.expected ?? 0} passed, ${st.unexpected ?? 0} failed, ${st.flaky ?? 0} flaky, ${st.skipped ?? 0} skipped`)
  const projects = new Set(rows.map((x) => x.project))
  const missing = PW_PROJECTS.filter((p) => !projects.has(p))
  report.add('projetos E2E desktop e mobile', missing.length ? 'fail' : 'pass', missing.length ? `faltando: ${missing.join(', ')}` : '')
  return rows
}

function checkAcceptance(report, task) {
  const ids = acceptanceIds(task.id)
  if (!ids.length) {
    report.add('critérios na SPEC', 'fail', `nenhum AC-${task.id}-nn encontrado em SPEC.md`)
    return
  }
  report.add('critérios na SPEC', 'pass', ids.join(', '))

  const dir = `tests/acceptance/${task.id}`
  const all = walk(join(ROOT, dir))
  const vitestFiles = all.filter((f) => /\.test\.tsx?$/.test(f))
  const pwFiles = all.filter((f) => /\.e2e\.ts$/.test(f))
  if (!vitestFiles.length && !pwFiles.length) {
    report.add('arquivos de teste', 'fail', `nenhum *.test.ts nem *.e2e.ts em ${dir}/`)
    return
  }
  report.add('arquivos de teste', 'pass', `${vitestFiles.length} vitest, ${pwFiles.length} playwright`)

  const source = [...vitestFiles, ...pwFiles].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n')
  const missing = ids.filter((id) => !source.includes(id))
  report.add('todo AC referenciado em teste', missing.length ? 'fail' : 'pass', missing.length ? `sem teste: ${missing.join(', ')}` : '')

  startInfra(report, task)
  mkdirSync(REPORTS, { recursive: true })
  const results = [...runVitest(report, task, dir, vitestFiles), ...runPlaywright(report, task, dir, pwFiles)]

  for (const id of ids) {
    const mine = results.filter((t) => t.title.includes(id))
    const passed = mine.filter((t) => t.status === 'passed')
    const failed = mine.filter((t) => t.status === 'failed')
    const skipped = mine.filter((t) => t.status === 'skipped')
    // Um AC verificado no navegador precisa passar nos DOIS projetos (desktop e mobile).
    const pwProjects = new Set(mine.filter((t) => t.runner === 'playwright' && t.status === 'passed').map((t) => t.project))
    const pwUsed = mine.some((t) => t.runner === 'playwright')
    const pwMissing = pwUsed ? PW_PROJECTS.filter((p) => !pwProjects.has(p)) : []
    const ok = mine.length > 0 && passed.length > 0 && !failed.length && !skipped.length && !pwMissing.length
    const detail = !mine.length
      ? 'nenhum teste executado com este ID'
      : `${passed.length} passed${failed.length ? `, ${failed.length} failed: ${failed.map((t) => `${t.title}${t.project ? ` [${t.project}]` : ''}`).join(' | ').slice(0, 220)}` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}${pwMissing.length ? `, sem passar em: ${pwMissing.join(', ')}` : ''}`
    report.add(id, ok ? 'pass' : 'fail', detail)
    if (failed.length) report.checks.at(-1).failures = failed.map((t) => ({ title: t.title, project: t.project, messages: t.messages }))
  }
}

// ---------- papéis ----------

function depsUnmet(task) {
  return task.deps.filter((d) =>
    ['operario', 'tester'].some((role) => {
      const f = join(REPORTS, `${d}-${role}.json`)
      return !existsSync(f) || !JSON.parse(readFileSync(f, 'utf8')).ok
    }),
  )
}

function verifyOperario(task, opts) {
  const report = new Report(task.id, 'operario', opts)
  console.log(`\n${C.b}${task.id} — ${task.title} · OPERÁRIO${C.r}`)
  const unmet = depsUnmet(task)
  if (unmet.length) report.add('dependências aceitas', 'warn', `sem relatório aprovado: ${unmet.join(', ')}`)
  checkFiles(report, task.requiredFiles, 'arquivo')
  if (opts.skipCommands) report.add('comandos', 'skip', '--skip-commands')
  else checkCommands(report, task.commands)
  checkForbidden(report, FORBIDDEN)
  checkScope(report, [...task.paths, ...SHARED_PATHS], ['tests/**'], opts)
  return report
}

function verifyTester(task, opts) {
  const report = new Report(task.id, 'tester', opts)
  console.log(`\n${C.b}${task.id} — ${task.title} · TESTER${C.r}`)
  if (task.testerRequiredFiles) checkFiles(report, task.testerRequiredFiles, 'arquivo')
  checkForbidden(report, TESTER_FORBIDDEN)
  checkAcceptance(report, task)
  checkScope(report, ['tests/**'], [], opts)
  return report
}

// ---------- comandos de planejamento ----------

function heights() {
  // Altura = maior número de tarefas dependentes em cadeia (caminho crítico até o fim).
  const dependents = new Map(TASKS.map((t) => [t.id, []]))
  for (const t of TASKS) for (const d of t.deps) dependents.get(d).push(t.id)
  const memo = new Map()
  const h = (id) => {
    if (memo.has(id)) return memo.get(id)
    const v = 1 + Math.max(0, ...dependents.get(id).map(h))
    memo.set(id, v)
    return v
  }
  return new Map(TASKS.map((t) => [t.id, h(t.id)]))
}

function reportStatus(id) {
  return ['operario', 'tester'].map((role) => {
    const f = join(REPORTS, `${id}-${role}.json`)
    if (!existsSync(f)) return '·'
    return JSON.parse(readFileSync(f, 'utf8')).ok ? `${C.ok}ok${C.r}` : `${C.fail}x${C.r}`
  })
}

function list() {
  const spec = readSpec()
  console.log(`${C.b}Onda  Tarefa  op/test  Título${C.r}`)
  for (const t of TASKS) {
    const acs = acceptanceIds(t.id, spec).length
    console.log(`  ${String(t.wave).padEnd(4)} ${t.id.padEnd(6)}  ${reportStatus(t.id).join('/').padEnd(7)}  ${t.todo ? '[TODO] ' : ''}${t.title} ${C.dim}(${acs} ACs; deps: ${t.deps.join(', ') || '—'})${C.r}`)
  }
}

function plan(max) {
  const h = heights()
  const waves = [...new Set(TASKS.map((t) => t.wave))].sort((a, b) => a - b)
  for (const w of waves) {
    const tasks = TASKS.filter((t) => t.wave === w).sort((a, b) => h.get(b.id) - h.get(a.id))
    console.log(`${C.b}Onda ${w}${C.r} — ${tasks.length} tarefa(s), ${tasks.length * 2} agentes (Operário+Tester)`)
    for (let i = 0; i < tasks.length; i += max) {
      const batch = tasks.slice(i, i + max)
      console.log(`  lote ${i / max + 1}: ${batch.map((t) => `${t.id}${t.todo ? '(TODO)' : ''}[h${h.get(t.id)}]`).join(' ')}`)
    }
  }
}

function lintSpec() {
  const spec = readSpec()
  const problems = []
  if (!spec) problems.push('spec/SPEC.md não encontrado')
  const headings = [...spec.matchAll(/^### (T\d{2,3}) — /gm)].map((m) => m[1])
  const ids = new Set(TASKS.map((t) => t.id))
  for (const t of TASKS) if (!headings.includes(t.id)) problems.push(`${t.id} está em tasks.mjs mas não tem "### ${t.id} — " na SPEC`)
  for (const hId of headings) if (!ids.has(hId)) problems.push(`${hId} tem seção na SPEC mas não está em tasks.mjs`)
  const dupHeads = headings.filter((x, i) => headings.indexOf(x) !== i)
  if (dupHeads.length) problems.push(`seções duplicadas: ${[...new Set(dupHeads)].join(', ')}`)
  const allAcs = [...spec.matchAll(/\*\*(AC-(T\d{2,3})-(\d{2}))\*\*/g)]
  const seen = new Map()
  for (const m of allAcs) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1)
  for (const [id, n] of seen) if (n > 1) problems.push(`${id} definido ${n}x`)
  for (const t of TASKS) {
    const acs = acceptanceIds(t.id, spec)
    if (!t.todo && acs.length < 3) problems.push(`${t.id} tem ${acs.length} AC(s); mínimo 3`)
    const nums = acs.map((a) => Number(a.slice(-2)))
    nums.forEach((n, i) => n !== i + 1 && problems.push(`${t.id}: numeração de AC fora de sequência (${acs[i]})`))
  }
  // Tabela de ondas da SPEC (linhas "| <onda> | Txx |") precisa bater com as ondas calculadas.
  for (const m of spec.matchAll(/^\| (\d+) \| (T\d{2,3}) \|/gm)) {
    const t = TASKS.find((x) => x.id === m[2])
    if (t && t.wave !== Number(m[1])) problems.push(`tabela de ondas: ${m[2]} na onda ${m[1]}, calculada ${t.wave}`)
  }
  if (problems.length) {
    console.log(`${C.fail}SPEC inconsistente (${problems.length}):${C.r}`)
    problems.forEach((p) => console.log(`  ✘ ${p}`))
    return false
  }
  console.log(`${C.ok}SPEC consistente${C.r}: ${TASKS.length} tarefas, ${seen.size} ACs, ${new Set(TASKS.map((t) => t.wave)).size} ondas`)
  return true
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
    else if (a === '--max') opts.max = Number(argv[++i])
    else opts.positional.push(a)
  }
  return opts
}

function usage() {
  console.log(`Uso:
  node spec/verify/verify.mjs list
  node spec/verify/verify.mjs plan [--max 4]
  node spec/verify/verify.mjs lint-spec
  node spec/verify/verify.mjs <Txx> --role operario|tester [--base <git-ref>] [--strict-scope] [--skip-commands]
  node spec/verify/verify.mjs wave <n>`)
  process.exit(2)
}

const opts = parseArgs(process.argv.slice(2))
const [cmd, arg] = opts.positional

if (!cmd) usage()
if (cmd === 'list') {
  list()
  process.exit(0)
}
if (cmd === 'plan') {
  plan(opts.max > 0 ? opts.max : 4)
  process.exit(0)
}
if (cmd === 'lint-spec') process.exit(lintSpec() ? 0 : 1)

if (cmd === 'wave') {
  const n = Number(arg)
  if (Number.isNaN(n)) usage()
  const reports = []
  for (const t of TASKS.filter((t) => t.wave <= n && !t.todo)) {
    const op = verifyOperario(t, { ...opts, base: undefined })
    const te = verifyTester(t, { ...opts, base: undefined })
    op.save()
    te.save()
    reports.push(op, te)
  }
  const failed = reports.filter((r) => !r.ok)
  console.log(`\n${failed.length ? C.fail + 'REPROVADO' : C.ok + 'APROVADO'}${C.r} — onda ≤ ${n}: ${reports.length - failed.length}/${reports.length} verificações ok`)
  failed.forEach((r) => console.log(`  ✘ ${r.task} ${r.role}`))
  process.exit(failed.length ? 1 : 0)
}

const task = TASKS.find((t) => t.id === cmd.toUpperCase())
if (!task || !['operario', 'tester'].includes(opts.role)) usage()
if (task.todo) {
  console.log(`${C.warn}${task.id} está marcada como TODO (aguardando spec). Não despache nem verifique.${C.r}`)
  process.exit(2)
}

const report = opts.role === 'operario' ? verifyOperario(task, opts) : verifyTester(task, opts)
const file = report.save()
console.log(`\n${report.ok ? C.ok + 'APROVADO' : C.fail + 'REPROVADO'}${C.r} — ${task.id} ${opts.role} · relatório: ${file}`)
process.exit(report.ok ? 0 : 1)
