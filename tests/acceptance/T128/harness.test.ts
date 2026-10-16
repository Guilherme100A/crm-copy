// AC-T128-04 — harness E2E (`node scripts/e2e/serve.mjs`) com banco clonado do modelo `all` + seed; o reset volta ao
// seed no mesmo banco clonado; criação do banco do harness mais rápida que a migração completa (medida aqui e em
// docs/testing.md). Contrato: e2e-server.json { database, database_template }, stdout E2E_DATABASE_TEMPLATE e
// E2E_DATABASE_READY_MS. Porta/Redis isolados por E2E_PORTS_ROOT fictício (como na T124); limpeza de órfãos desligada.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readText } from '../helpers/exec'
import { dbUrl, ident, sqlOk } from '../helpers/pg'
import { http, startServe, type ServeProc } from '../T17/serve'
import { accName, BASE, dbExists, dbFlags, dropDb, journalEntries, median, migrationRows, schemaSnapshot, templateDbMod, tmp, type Any } from './support'

const procs: ServeProc[] = []
const extra: string[] = []
const temps: { drop: () => Promise<unknown> }[] = []

afterAll(async () => {
  for (const p of procs) await p.stop().catch(() => p.kill())
  for (const t of temps) await t.drop().catch(() => {})
  for (const n of extra) if (dbExists(n)) dropDb(n)
  rmSync(tmp, { recursive: true, force: true })
}, 240_000)

const seedState = (url: string) =>
  sqlOk(url, `SELECT (SELECT count(*) FROM crm.users), (SELECT count(*) FROM crm.companies), (SELECT coalesce(string_agg(email, ',' ORDER BY email), '') FROM crm.users);`)[0]!.join(' / ')

describe('T128 — harness E2E a partir do banco-modelo', () => {
  it('AC-T128-04 serve.mjs sobe com o banco clonado do modelo + seed, e POST /__e2e/reset volta ao seed no mesmo banco clonado', async () => {
    const infoPath = join(tmp, 'e2e-server.json')
    const p = await startServe(
      { E2E_PORTS_ROOT: `C:/t128-sim/serve-${process.pid}`, E2E_SERVER_INFO: infoPath, E2E_SKIP_WEB: '1', E2E_ORPHAN_CLEANUP: '0' },
      240_000,
    )
    procs.push(p)
    const out = p.output()
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    const expectedTpl = (await templateDbMod()).templateDatabaseName('all')
    expect(info.database_template, out).toBe(expectedTpl)
    expect(out).toContain(`E2E_DATABASE_TEMPLATE=${expectedTpl}`)
    expect(out).toMatch(/E2E_DATABASE_READY_MS=\d+/)
    expect(info.database).toBe(p.info.database)
    expect(info.database).toMatch(/^crm_e2e_/)
    expect(dbFlags(expectedTpl)).toEqual({ exists: true, template: true, allowConn: false })

    const url = dbUrl(info.database)
    // schema do clone = schema do modelo (comparado com outro clone, o modelo não aceita conexões)
    const testing: Any = await import('@crm/db/testing')
    const ref = await testing.createTempDatabase({ migrate: true })
    temps.push(ref)
    const s = schemaSnapshot(url)
    const r = schemaSnapshot(ref.url)
    expect(s.tables).toEqual(r.tables)
    expect(s.columns).toEqual(r.columns)
    expect(s.indexes).toEqual(r.indexes)
    expect(migrationRows(url)).toEqual([`wa=${journalEntries('wa')}`, `crm=${journalEntries('crm')}`])

    // seed aplicado depois do clone (o modelo só tem schema)
    const seeded = seedState(url)
    expect(Number(seeded.split(' / ')[0])).toBeGreaterThan(0)
    expect(Number(seeded.split(' / ')[1])).toBeGreaterThan(0)
    expect(seedState(ref.url).startsWith('0 / 0')).toBe(true)
    expect((await http(p.info.apiUrl, 'GET', '/health')).status).toBe(200)

    // estraga o estado e reseta
    sqlOk(url, `TRUNCATE crm.users, crm.companies CASCADE;`)
    expect(seedState(url).startsWith('0 / 0')).toBe(true)
    const reset = await http(p.info.apiUrl, 'POST', '/__e2e/reset', {})
    expect(reset.status, reset.text).toBe(200)
    expect(seedState(url)).toBe(seeded)
    expect(migrationRows(url)).toEqual([`wa=${journalEntries('wa')}`, `crm=${journalEntries('crm')}`])
    expect(schemaSnapshot(url).tables).toEqual(r.tables)
    // continua no mesmo banco clonado
    expect(JSON.parse(readFileSync(infoPath, 'utf8')).database).toBe(info.database)

    const stopped = await p.stop(60_000)
    expect(stopped?.code, p.output()).toBe(0)
    procs.pop()
  })

  it('AC-T128-04 criar o banco do harness pelo modelo (template-db.mjs, o caminho do serve.mjs) é mais rápido que a migração completa', async () => {
    const { cloneTemplateDatabase } = await templateDbMod()
    const { migrateUrl } = await import('@crm/db')
    // aquece: modelo existe e o caminho rápido em JS puro é o usado
    const warm = accName('warm')
    extra.push(warm)
    await cloneTemplateDatabase(warm, { baseUrl: BASE, set: 'all' })
    const clone: number[] = []
    const full: number[] = []
    for (let i = 0; i < 3; i++) {
      const a = accName('clone')
      extra.push(a)
      let t0 = Date.now()
      const res = await cloneTemplateDatabase(a, { baseUrl: BASE, set: 'all' })
      clone.push(Date.now() - t0)
      expect(res.created).toBe(false)

      const b = accName('full')
      extra.push(b)
      t0 = Date.now()
      sqlOk(BASE, `CREATE DATABASE ${ident(b)};`)
      await migrateUrl(dbUrl(b), { set: 'all' })
      full.push(Date.now() - t0)
    }
    console.log(`[AC-T128-04] clone ${clone.join(',')} ms (mediana ${median(clone)}) × migração completa ${full.join(',')} ms (mediana ${median(full)})`)
    expect(median(clone)).toBeLessThan(median(full))
  })

  it('AC-T128-04 docs/testing.md registra a medição do harness: migração completa × clone do modelo', () => {
    const doc = readText('docs/testing.md')
    const sec = doc.slice(doc.indexOf('T128'))
    expect(sec).toMatch(/banco-modelo/i)
    expect(sec).toMatch(/serve\.mjs/)
    expect(sec).toMatch(/CRM_TEST_TEMPLATE=0/)
    expect(sec).toMatch(/--rebuild/)
    const row = sec.split('\n').find((l) => /\|.*serve\.mjs/.test(l))
    expect(row, 'linha da tabela de medição do harness').toBeTruthy()
    expect(row!.match(/\d+[,.]?\d*\s*s/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
