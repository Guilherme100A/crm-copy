// AC-T124-01..03 — harness E2E: reset serializado, limpeza de bancos órfãos e timeout do reset (contrato com o Bigorna):
// scripts/e2e/orphans.mjs: cleanupOrphanDatabases({ baseUrl, minAgeMs, now, protect, dryRun }) → { dropped, kept[{ name, reason }] },
//   isOrphanCandidate(name); serve.mjs: E2E_ORPHAN_MIN_AGE_MIN, E2E_RESET_TIMEOUT_MS, stdout E2E_ORPHANS_DROPPED=<n>,
//   e2e-server.json { orphans: { dropped, kept, min_age_min }, reset_timeout_ms }; POST /__e2e/reset → { ok, waited_ms, … } | 504.
// SEGURANÇA: o Postgres é compartilhado por vários worktrees. A chamada que apaga de verdade recebe em `protect` todo banco de
// teste que não foi criado por esta suíte E é restrita por `match` ao tag da suíte: só os bancos `*_t124_<pid>_*` podem ser apagados.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { rootPath } from '../helpers/exec'
import { DEFAULT_DATABASE_URL, dbUrl, ident, lit, sql, sqlOk } from '../helpers/pg'
import { http, startServe, type ServeProc } from '../T17/serve'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const orphansMod = async (): Promise<Any> => import(pathToFileURL(rootPath('scripts', 'e2e', 'orphans.mjs')).href)
const tmp = mkdtempSync(join(tmpdir(), 'crm-t124-'))
const procs: ServeProc[] = []
const tag = `t124_${process.pid}_${Date.now().toString(36)}`
const created: string[] = []
const holders: Any[] = []

const dbExists = (name: string) => sqlOk(DEFAULT_DATABASE_URL, `SELECT count(*) FROM pg_database WHERE datname = ${lit(name)};`)[0]?.[0] === '1'
function createDb(name: string) {
  sqlOk(DEFAULT_DATABASE_URL, `CREATE DATABASE ${ident(name)};`)
  created.push(name)
}
/** Todos os bancos com prefixo de teste que NÃO são desta suíte (vão em protect). */
/** Só os bancos desta suíte podem ser candidatos (match), mesmo que outro worktree crie bancos durante o teste. */
const ONLY_MINE = new RegExp(tag)
const foreignTestDbs = () =>
  sqlOk(DEFAULT_DATABASE_URL, `SELECT datname FROM pg_database WHERE datname ~ '^(crm_e2e_|crm_test_|crm_acc_)' AND datname NOT LIKE ${lit(`%${tag}%`)};`).map((r) => r[0]!)

afterAll(async () => {
  for (const p of procs) await p.stop().catch(() => p.kill())
  for (const h of holders) await h.$client?.end?.().catch(() => {})
  for (const name of created) if (dbExists(name)) sql(DEFAULT_DATABASE_URL, `DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE);`)
  rmSync(tmp, { recursive: true, force: true })
}, 120_000)

describe('T124 — limpeza de bancos órfãos', () => {
  it('AC-T124-02 isOrphanCandidate só aceita os prefixos de teste do projeto', async () => {
    const { isOrphanCandidate } = await orphansMod()
    for (const n of ['crm_e2e_abc', 'crm_test_x1', 'crm_acc_t30_y']) expect(isOrphanCandidate(n), n).toBe(true)
    for (const n of ['crm', 'postgres', 'template1', 'wsm', 'wsm_dev', 'crm_e2e', 'crmtest_x', 'meu_crm_test_x', 'crm_prod']) expect(isOrphanCandidate(n), n).toBe(false)
  })

  it('AC-T124-02 apaga só bancos de teste sem conexão e antigos; preserva os com conexão, os recentes, os protegidos e os fora dos prefixos', async () => {
    const { cleanupOrphanDatabases } = await orphansMod()
    const old = `crm_test_${tag}_old`
    const busy = `crm_acc_${tag}_busy`
    const guarded = `crm_e2e_${tag}_guarded`
    const outside = `wsm_${tag}_keep`
    for (const n of [old, busy, guarded, outside]) createDb(n)
    // conexão ativa no "busy"
    const { createDb: open } = await import('@crm/db')
    const holder: Any = open(dbUrl(busy))
    holders.push(holder)
    await holder.$client.query('SELECT 1')

    // 1) com a idade mínima padrão (30 min) os recém-criados ficam como 'recent' (dry-run: nada é apagado)
    const dry = await cleanupOrphanDatabases({ baseUrl: DEFAULT_DATABASE_URL, minAgeMs: 30 * 60_000, dryRun: true })
    const keptDry = new Map(dry.kept.map((k: Any) => [k.name, k.reason]))
    expect(keptDry.get(old)).toBe('recent')
    expect(keptDry.get(guarded)).toBe('recent')
    expect(['active', 'recent']).toContain(keptDry.get(busy))
    expect(dry.dropped).not.toContain(old)
    expect([...keptDry.keys(), ...dry.dropped]).not.toContain(outside) // fora dos prefixos nem aparece
    expect(dbExists(old)).toBe(true)

    // 2) idade mínima 0, protegendo todo banco de teste alheio e o "guarded": só o "old" pode sair
    const res = await cleanupOrphanDatabases({ baseUrl: DEFAULT_DATABASE_URL, minAgeMs: 0, match: ONLY_MINE, protect: [...foreignTestDbs(), guarded] })
    expect(res.dropped).toEqual([old])
    const kept = new Map(res.kept.map((k: Any) => [k.name, k.reason]))
    expect(kept.get(busy)).toBe('active')
    expect(kept.get(guarded)).toBe('protected')
    expect(dbExists(old)).toBe(false)
    for (const n of [busy, guarded, outside]) expect(dbExists(n), n).toBe(true)
    for (const n of ['crm', 'postgres']) expect(dbExists(n), n).toBe(true)

    // 3) sem a conexão, o "busy" vira candidato
    await holder.$client.end()
    holders.splice(holders.indexOf(holder), 1)
    const again = await cleanupOrphanDatabases({ baseUrl: DEFAULT_DATABASE_URL, minAgeMs: 0, match: ONLY_MINE, protect: [...foreignTestDbs(), guarded], dryRun: true })
    expect(again.dropped).toContain(busy)
    expect(dbExists(busy)).toBe(true) // dry-run
  })

  it('AC-T124-02 ao subir, o harness roda a limpeza antes do E2E_READY e registra o resultado (banco recente preservado)', async () => {
    const fresh = `crm_e2e_${tag}_fresh`
    createDb(fresh)
    const info = join(tmp, 'ac02.json')
    const p = await startServe({ E2E_PORTS_ROOT: `C:/t124-sim/orph-${process.pid}`, E2E_SERVER_INFO: info, E2E_SKIP_WEB: '1' }, 240_000)
    procs.push(p)
    const out = p.output()
    expect(out).toMatch(/E2E_ORPHANS_DROPPED=\d+/)
    expect(out.indexOf('E2E_ORPHANS_DROPPED=')).toBeLessThan(out.indexOf('E2E_READY'))
    const j = JSON.parse(readFileSync(info, 'utf8'))
    expect(j.orphans).toMatchObject({ min_age_min: 30 })
    expect(Array.isArray(j.orphans.dropped)).toBe(true)
    expect(j.orphans.kept.find((k: Any) => k.name === fresh)?.reason).toBe('recent')
    expect(dbExists(fresh)).toBe(true)
    // o banco do próprio harness nunca é apagado
    expect(j.orphans.dropped).not.toContain(p.info.database)
    expect(dbExists(p.info.database)).toBe(true)
    expect((await p.stop())?.code).toBe(0)
  }, 300_000)
})

describe('T124 — reset serializado e timeout', () => {
  const seedCounts = (database: string) =>
    sqlOk(dbUrl(database), `SELECT (SELECT count(*) FROM crm.users), (SELECT count(*) FROM crm.companies), (SELECT count(*) FROM crm.company_members);`)[0]!.join('/')

  it('AC-T124-01 / AC-T124-03 dois resets simultâneos terminam com 200 e o seed fica íntegro; reset_timeout_ms no e2e-server.json', async () => {
    const info = join(tmp, 'ac01.json')
    const p = await startServe({ E2E_PORTS_ROOT: `C:/t124-sim/reset-${process.pid}`, E2E_SERVER_INFO: info, E2E_SKIP_WEB: '1', E2E_RESET_TIMEOUT_MS: '90000' }, 240_000)
    procs.push(p)
    expect(JSON.parse(readFileSync(info, 'utf8')).reset_timeout_ms).toBe(90_000)

    const one = await http(p.info.apiUrl, 'POST', '/__e2e/reset', {})
    expect(one.status, one.text).toBe(200)
    const baseline = seedCounts(p.info.database)

    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([0, 1, 2].map(() => http(p.info.apiUrl, 'POST', '/__e2e/reset', {})))
      for (const r of results) {
        expect(r.status, r.text).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(typeof r.body.waited_ms).toBe('number')
      }
      // serializados: ao menos um esperou na fila
      expect(Math.max(...results.map((r) => r.body.waited_ms))).toBeGreaterThan(0)
      expect(seedCounts(p.info.database)).toBe(baseline)
    }
    expect((await p.stop())?.code).toBe(0)
  }, 300_000)

  it('AC-T124-03 padrão do timeout ≥ 60000; estourado → 504 reset_timeout, e o reset seguinte espera (sem 500 de chave duplicada)', async () => {
    const infoDefault = join(tmp, 'ac03-default.json')
    const d = await startServe({ E2E_PORTS_ROOT: `C:/t124-sim/def-${process.pid}`, E2E_SERVER_INFO: infoDefault, E2E_SKIP_WEB: '1' }, 240_000)
    procs.push(d)
    expect(JSON.parse(readFileSync(infoDefault, 'utf8')).reset_timeout_ms).toBeGreaterThanOrEqual(60_000)
    expect((await d.stop())?.code).toBe(0)

    const info = join(tmp, 'ac03-tiny.json')
    const p = await startServe({ E2E_PORTS_ROOT: `C:/t124-sim/tiny-${process.pid}`, E2E_SERVER_INFO: info, E2E_SKIP_WEB: '1', E2E_RESET_TIMEOUT_MS: '1' }, 240_000)
    procs.push(p)
    expect(JSON.parse(readFileSync(info, 'utf8')).reset_timeout_ms).toBe(1)
    const results = await Promise.all([0, 1].map(() => http(p.info.apiUrl, 'POST', '/__e2e/reset', {})))
    for (const r of results) {
      expect([200, 504], r.text).toContain(r.status)
      expect(r.status, r.text).not.toBe(500)
      if (r.status === 504) expect(r.body).toMatchObject({ ok: false, error: 'reset_timeout', timeout_ms: 1 })
    }
    expect(results.some((r) => r.status === 504)).toBe(true)
    // os resets continuam e terminam: o seed fica íntegro
    await new Promise((r) => setTimeout(r, 15_000))
    const counts = sqlOk(dbUrl(p.info.database), `SELECT count(*) FROM crm.users;`)[0]![0]
    expect(Number(counts)).toBeGreaterThan(0)
    expect((await p.stop())?.code).toBe(0)
  }, 300_000)
})
