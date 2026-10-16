// AC-T126-01..04: estabilidade das suítes sob carga (prefixo de fila por arquivo, execuções simultâneas, teardown sem
// 57P01 e testes de janela de tempo sob carga). Os testes rodam as suítes REAIS em processos filhos (pnpm/vitest),
// sem rede externa, com o ambiente de teste padrão (fakes). Logs e relatórios ficam no diretório temporário do SO.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { childTestEnv, execAsync, tailOf, type AsyncExecResult } from '../helpers/exec-async'
import { ensureInstalled, toPosix } from '../helpers/exec'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const MIN = 60_000
let WORK = ''
beforeAll(() => {
  const inst = ensureInstalled()
  if (inst && inst.code !== 0) throw new Error(`pnpm install falhou:\n${inst.output.slice(-2000)}`)
  WORK = toPosix(mkdtempSync(join(tmpdir(), 'crm-t126-')))
})
afterAll(() => {
  // os logs ficam para diagnóstico (diretório temporário do SO)
  if (WORK) console.info(`[T126] logs e relatórios em ${WORK}`)
})

let seq = 0
const tag = (name: string) => `${String(++seq).padStart(2, '0')}-${name}`

/** Sinais de banco derrubado por baixo de uma conexão viva (o que a T126 elimina). */
const ADMIN_SHUTDOWN = /57P01|admin_shutdown|terminating connection due to administrator command/i

interface SuiteRun {
  run: AsyncExecResult
  report: Any | null
  name: string
}

/** `pnpm --filter <pkg> test -- …` com relatório JSON (mais o reporter padrão no log). */
async function runSuite(pkg: string, name: string, extra = '', timeoutMs = 25 * MIN): Promise<SuiteRun> {
  const json = `${WORK}/${name}.json`
  const run = await execAsync(`pnpm --filter ${pkg} test -- --reporter=default --reporter=json --outputFile.json="${json}" ${extra}`, {
    logFile: `${WORK}/${name}.log`,
    timeoutMs,
  })
  const report = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null
  return { run, report, name }
}

const assertions = (report: Any): Any[] => (report?.testResults ?? []).flatMap((f: Any) => f.assertionResults ?? [])

function failedNames(report: Any): string[] {
  const bad = assertions(report).filter((a) => a.status === 'failed').map((a) => a.fullName)
  for (const f of report?.testResults ?? []) if (f.status === 'failed' && !(f.assertionResults ?? []).length) bad.push(`${f.name}: ${f.message}`)
  return bad
}

/** Suíte verde: exit 0, relatório com testes, nenhuma falha (de teste ou de arquivo) e nenhum 57P01 no log. */
function expectGreen(s: SuiteRun) {
  const ctx = `${s.name}\n${tailOf(s.run)}`
  expect(s.run.timedOut, `timeout: ${ctx}`).toBe(false)
  expect(s.report, `sem relatório JSON: ${ctx}`).toBeTruthy()
  expect(failedNames(s.report), `falhas: ${ctx}`).toEqual([])
  expect(s.report.numFailedTestSuites, ctx).toBe(0)
  expect(s.report.numTotalTests, ctx).toBeGreaterThan(0)
  expect(s.report.success, ctx).toBe(true)
  expect(s.run.code, ctx).toBe(0)
  expect(s.run.output().match(ADMIN_SHUTDOWN)?.[0] ?? null, `57P01 no log: ${ctx}`).toBeNull()
}

function expectPassed(s: SuiteRun, id: string) {
  const hits = assertions(s.report).filter((a) => String(a.fullName).includes(id))
  expect(hits.length, `${id} não rodou em ${s.name}\n${tailOf(s.run)}`).toBeGreaterThan(0)
  expect(
    hits.filter((a) => a.status !== 'passed').map((a) => `${a.fullName}: ${a.status}`),
    `${id} em ${s.name}`,
  ).toEqual([])
}

describe('AC-T126-01 prefixo de fila por arquivo', () => {
  interface Probe {
    label: string
    fromSetup: { crm: string | null; wa: string | null }
    used: string
    helper: { crm: string; wa: string } | null
    queuePrefix: string
    consumed: Array<{ from: string; i: number }>
  }

  async function runFixtures(name: string, extraEnv: Record<string, string> = {}) {
    const out = `${WORK}/${name}`
    mkdirSync(out, { recursive: true })
    const run = await execAsync('pnpm exec vitest run --config tests/acceptance/T126/fixtures/vitest.fixture.config.ts', {
      logFile: `${out}/run.log`,
      timeoutMs: 5 * MIN,
      env: childTestEnv({ T126_OUT: out, T126_TAG: `t126:${process.pid}:${randomBytes(4).toString('hex')}`, ...extraEnv }),
    })
    expect(run.code, tailOf(run)).toBe(0)
    const read = (l: string): Probe => JSON.parse(readFileSync(`${out}/${l}.json`, 'utf8'))
    return { run, a: read('A'), b: read('B') }
  }

  const FILE_PREFIX = /^(crm-t-.+)-f[0-9a-f]{8}-[0-9a-f]{4}$/

  it('AC-T126-01 dois arquivos da mesma execução recebem prefixos diferentes e não consomem jobs um do outro', async () => {
    const { a, b } = await runFixtures(tag('ac01-isolado'))
    // prefixos do setup: definidos, diferentes entre arquivos, mesma execução
    expect(a.fromSetup.crm).toBeTruthy()
    expect(b.fromSetup.crm).toBeTruthy()
    expect(a.fromSetup.crm).not.toBe(b.fromSetup.crm)
    expect(a.fromSetup.wa).not.toBe(b.fromSetup.wa)
    expect(a.fromSetup.wa).toMatch(/^wsm-t-/)
    expect(b.fromSetup.wa).toMatch(/^wsm-t-/)
    const runA = FILE_PREFIX.exec(a.fromSetup.crm!)?.[1]
    const runB = FILE_PREFIX.exec(b.fromSetup.crm!)?.[1]
    expect(runA, `formato inesperado: ${a.fromSetup.crm}`).toBeTruthy()
    expect(runA).toBe(runB)
    // a fila usa o prefixo do arquivo, e o helper exportado confirma
    expect(a.queuePrefix).toBe(a.fromSetup.crm)
    expect(b.queuePrefix).toBe(b.fromSetup.crm)
    if (a.helper) expect(a.helper).toEqual({ crm: a.fromSetup.crm, wa: a.fromSetup.wa })
    if (b.helper) expect(b.helper).toEqual({ crm: b.fromSetup.crm, wa: b.fromSetup.wa })
    // cada worker consumiu só (e todos) os próprios jobs, mesmo com os de B parados 3 s na mesma fila
    expect(a.consumed.filter((j) => j.from !== 'A')).toEqual([])
    expect(b.consumed.filter((j) => j.from !== 'B')).toEqual([])
    expect(a.consumed).toHaveLength(20)
    expect(b.consumed).toHaveLength(20)
  }, 10 * MIN)

  it('AC-T126-01 controle: com o mesmo prefixo forçado nos dois arquivos, a sonda detecta o consumo cruzado', async () => {
    const { a } = await runFixtures(tag('ac01-controle'), { T126_SHARED_PREFIX: `crm-t126-shared-${process.pid}-${randomBytes(4).toString('hex')}` })
    expect(a.used).toBe(a.queuePrefix)
    expect(a.consumed.filter((j) => j.from === 'B').length, 'sem prefixo próprio, o worker de A deveria pegar jobs de B').toBeGreaterThan(0)
  }, 10 * MIN)
})

describe('AC-T126-02 duas execuções simultâneas da suíte da API', () => {
  it('AC-T126-02 duas `pnpm --filter @crm/api test` ao mesmo tempo passam, com AC-T17-03 (reset ≤ 3 s) em cada uma', async () => {
    const [one, two] = await Promise.all([runSuite('@crm/api', tag('ac02-api-1')), runSuite('@crm/api', tag('ac02-api-2'))])
    for (const s of [one, two]) {
      expectGreen(s)
      expectPassed(s, 'AC-T17-03')
      expect(s.run.output()).not.toContain('nenhum db do Redis livre')
    }
  }, 40 * MIN)
})

describe('AC-T126-03 suítes completas 3x seguidas com outra em paralelo', () => {
  it('AC-T126-03 @crm/api, @crm/core e @crm/worker passam 3 vezes seguidas rodando juntas, sem falha e sem 57P01', async () => {
    // Em cada rodada as três suítes completas rodam ao mesmo tempo: cada uma tem outras suítes completas em paralelo.
    for (let round = 1; round <= 3; round++) {
      const runs = await Promise.all([
        runSuite('@crm/api', tag(`ac03-r${round}-api`)),
        runSuite('@crm/core', tag(`ac03-r${round}-core`)),
        runSuite('@crm/worker', tag(`ac03-r${round}-worker`)),
      ])
      for (const s of runs) expectGreen(s)
    }
  }, 120 * MIN)
})

describe('AC-T126-04 testes de janela de tempo sob carga', () => {
  it('AC-T126-04 AC-T68-01 e AC-T125-02 passam 10 vezes seguidas com outra suíte completa em paralelo', async () => {
    // carga: suíte completa da API em laço enquanto as repetições rodam
    const loadWindows: Array<{ start: number; end: number | null }> = []
    const loadRuns: SuiteRun[] = []
    let stop = false
    const load = (async () => {
      for (let i = 1; !stop; i++) {
        const w = { start: Date.now(), end: null as number | null }
        loadWindows.push(w)
        loadRuns.push(await runSuite('@crm/api', tag(`ac04-carga-${i}`)))
        w.end = Date.now()
      }
    })()
    const underLoad = (t: number) => loadWindows.some((w) => w.start <= t && (w.end === null || w.end >= t))
    try {
      // dá tempo de a carga subir (pnpm + vitest + bancos temporários)
      await new Promise((r) => setTimeout(r, 20_000))
      for (let rep = 1; rep <= 10; rep++) {
        const startedAt = Date.now()
        const [buffer, purchase] = await Promise.all([
          runSuite('@crm/core', tag(`ac04-rep${rep}-t68`), `src/ai-runtime/runtime.db.unit.test.ts -t "AC-T68-01"`, 10 * MIN),
          runSuite('@crm/worker', tag(`ac04-rep${rep}-t125`), `src/boot/production-meta.db.unit.test.ts -t "AC-T125-02"`, 10 * MIN),
        ])
        expect(underLoad(startedAt), `repetição ${rep} começou sem carga em paralelo`).toBe(true)
        for (const [s, id] of [
          [buffer, 'AC-T68-01'],
          [purchase, 'AC-T125-02'],
        ] as const) {
          expect(s.run.code, `rep ${rep}: ${tailOf(s.run)}`).toBe(0)
          expect(failedNames(s.report), `rep ${rep} ${id}: ${tailOf(s.run)}`).toEqual([])
          expectPassed(s, id)
        }
      }
    } finally {
      stop = true
      await load
    }
    expect(loadRuns.length).toBeGreaterThan(0)
  }, 120 * MIN)
})
