// AC-T128-01..03 — banco-modelo `crm_tpl_<set>_<hash12>`: mesmo schema da migração completa, criação única sob
// concorrência (no processo e entre processos) e troca de modelo quando o hash muda, com a limpeza de órfãos.
// Contrato e regras de segurança em ./support.ts.
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ROOT } from '../helpers/exec'
import { dbUrl, ident, sqlOk } from '../helpers/pg'
import {
  accName,
  BASE,
  dbExists,
  dbFlags,
  dropDb,
  journalEntries,
  migrationRows,
  orphansMod,
  schemaSnapshot,
  TAG,
  templateDbMod,
  tmp,
  waFolderCopy,
  type Any,
} from './support'

// Espião em `migrateUrl` (porta pública de @crm/db) para provar que o clone não roda migração.
vi.mock('../../../packages/db/src/client.ts', async (importOriginal) => {
  const orig = await importOriginal<Any>()
  return { ...orig, migrateUrl: vi.fn(orig.migrateUrl) }
})

const { migrateUrl } = (await import('../../../packages/db/src/client.ts')) as Any
const testing: Any = await import('@crm/db/testing')

const clones: string[] = []
const temps: { drop: () => Promise<unknown> }[] = []
const templates = new Set<string>()

afterAll(async () => {
  for (const t of temps) await t.drop().catch(() => {})
  for (const n of clones) if (dbExists(n)) dropDb(n)
  const left = [...templates].filter(dbExists)
  if (left.length) await testing.dropTemplateDatabases(BASE, left).catch(() => {})
}, 240_000)

async function temp(opts: Any) {
  const db = await testing.createTempDatabase(opts)
  temps.push(db)
  return db
}

describe('T128 — banco-modelo por hash das migrações', () => {
  it('AC-T128-01 createTempDatabase({ migrate: true }) tem o mesmo schema (tabelas, colunas, índices de crm e public) que a migração completa', async () => {
    const prev = process.env.CRM_TEST_TEMPLATE
    process.env.CRM_TEST_TEMPLATE = '0'
    let full: Any
    try {
      migrateUrl.mockClear()
      full = await temp({ migrate: true })
      expect(migrateUrl, 'CRM_TEST_TEMPLATE=0 deve migrar o banco inteiro').toHaveBeenCalled()
      expect(full.template).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.CRM_TEST_TEMPLATE
      else process.env.CRM_TEST_TEMPLATE = prev
    }
    const cloned = await temp({ migrate: true })
    const expectedTpl = (await templateDbMod()).templateDatabaseName('all')
    expect(cloned.template?.name).toBe(expectedTpl)
    expect(cloned.template.name).toMatch(/^crm_tpl_all_[0-9a-f]{12}$/)

    const a = schemaSnapshot(full.url)
    const b = schemaSnapshot(cloned.url)
    expect(a.tables.length).toBeGreaterThan(10)
    expect(a.indexes.length).toBeGreaterThan(10)
    expect(b.tables).toEqual(a.tables)
    expect(b.columns).toEqual(a.columns)
    expect(b.indexes).toEqual(a.indexes)
    expect(migrationRows(cloned.url)).toEqual(migrationRows(full.url))
    expect(migrationRows(cloned.url)).toEqual([`wa=${journalEntries('wa')}`, `crm=${journalEntries('crm')}`])

    // o modelo fica pronto para clonar: IS_TEMPLATE true / ALLOW_CONNECTIONS false
    expect(dbFlags(cloned.template.name)).toEqual({ exists: true, template: true, allowConn: false })
  })

  it('AC-T128-01 a partir da segunda chamada com as mesmas migrações nenhuma migração é executada (nasce do modelo crm_tpl_*)', async () => {
    await temp({ migrate: true }) // garante o modelo (pode ou não criá-lo)
    migrateUrl.mockClear()
    const second = await temp({ migrate: true })
    const third = await temp({ migrate: true, set: 'all' })
    expect(migrateUrl).not.toHaveBeenCalled()
    for (const db of [second, third]) {
      expect(db.template).toEqual({ name: (await templateDbMod()).templateDatabaseName('all'), created: false })
      expect(migrationRows(db.url)).toEqual([`wa=${journalEntries('wa')}`, `crm=${journalEntries('crm')}`])
    }
    // banco utilizável e independente do modelo
    sqlOk(second.url, `CREATE TABLE public.${ident(`t128_probe_${TAG}`)} (id int); INSERT INTO public.${ident(`t128_probe_${TAG}`)} VALUES (1);`)
    expect(sqlOk(third.url, `SELECT count(*) FROM pg_tables WHERE tablename = 't128_probe_${TAG}';`)[0]?.[0]).toBe('0')
  })

  it('AC-T128-02 oito createTempDatabase concorrentes (conjunto wa) devolvem bancos utilizáveis do mesmo modelo, sem 55006', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => temp({ migrate: true, set: 'wa' })))
    const errors = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message ?? r))
    expect(errors).toEqual([])
    const dbs = results.map((r) => (r as PromiseFulfilledResult<Any>).value)
    const expectedTpl = (await templateDbMod()).templateDatabaseName('wa')
    expect(new Set(dbs.map((d) => d.template?.name))).toEqual(new Set([expectedTpl]))
    expect(dbs.filter((d) => d.template.created).length).toBeLessThanOrEqual(1)
    for (const d of dbs) expect(sqlOk(d.url, 'SELECT count(*) FROM drizzle.__drizzle_migrations;')[0]?.[0]).toBe(String(journalEntries('wa')))
  })

  it('AC-T128-02 oito chamadas concorrentes no mesmo processo (sem cache) para um hash novo criam o modelo uma única vez', async () => {
    const wa = waFolderCopy('inproc')
    const tpl = testing.templateDatabaseName('wa', { wa })
    templates.add(tpl)
    expect(dbExists(tpl)).toBe(false)
    const names = Array.from({ length: 8 }, () => accName('inproc'))
    clones.push(...names)
    const results = await Promise.allSettled(
      names.map((n) => testing.cloneTemplateDatabase(n, { baseUrl: BASE, set: 'wa', folders: { wa }, cache: false })),
    )
    const errors = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message ?? r))
    expect(errors).toEqual([])
    const ok = results.map((r) => (r as PromiseFulfilledResult<Any>).value)
    expect(ok.every((r) => r.name === tpl)).toBe(true)
    expect(ok.filter((r) => r.created).length).toBe(1)
    expect(dbFlags(tpl)).toEqual({ exists: true, template: true, allowConn: false })
    for (const n of names) expect(sqlOk(dbUrl(n), 'SELECT count(*) FROM drizzle.__drizzle_migrations;')[0]?.[0]).toBe(String(journalEntries('wa')))
  })

  it('AC-T128-02 oito processos concorrentes para um hash novo criam o modelo uma única vez; os oito clones funcionam, sem "being accessed by other users"', async () => {
    const wa = waFolderCopy('procs')
    const tpl = testing.templateDatabaseName('wa', { wa })
    templates.add(tpl)
    expect(dbExists(tpl)).toBe(false)
    const go = join(tmp, `go-${Date.now()}`)
    const names = Array.from({ length: 8 }, () => accName('proc'))
    clones.push(...names)
    const kids = names.map((n) => {
      const child = spawn(process.execPath, [join(ROOT, 'tests', 'acceptance', 'T128', 'fixtures', 'clone-child.mjs'), ROOT, BASE, wa, n, go], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout!.on('data', (d) => (out += String(d)))
      child.stderr!.on('data', (d) => (out += String(d)))
      const ready = new Promise<void>((resolve, reject) => {
        const t = setInterval(() => out.includes('READY') && (clearInterval(t), resolve()), 20)
        child.once('exit', () => (clearInterval(t), out.includes('READY') ? resolve() : reject(new Error(`filho saiu antes do READY:\n${out}`))))
      })
      const done = new Promise<string>((resolve) => child.once('exit', () => resolve(out)))
      return { ready, done }
    })
    await Promise.all(kids.map((k) => k.ready))
    writeFileSync(go, 'go') // largada simultânea
    const outs = await Promise.all(kids.map((k) => k.done))
    const results = outs.map((o) => {
      const line = o.split(/\r?\n/).find((l) => l.startsWith('RESULT='))
      return line ? JSON.parse(line.slice(7)) : { ok: false, message: o }
    })
    expect(outs.join('\n')).not.toMatch(/being accessed by other users/i)
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.every((r) => r.name === tpl)).toBe(true)
    expect(results.filter((r) => r.created).length).toBe(1)
    expect(dbFlags(tpl)).toEqual({ exists: true, template: true, allowConn: false })
    for (const n of names) expect(sqlOk(dbUrl(n), 'SELECT count(*) FROM drizzle.__drizzle_migrations;')[0]?.[0]).toBe(String(journalEntries('wa')))
  })

  it('AC-T128-03 alterar o conteúdo de uma migração cria um modelo novo; a limpeza remove o antigo sem conexões e mantém o do hash atual', async () => {
    const { cleanupOrphanDatabases } = await orphansMod()
    const wa = waFolderCopy('hash')
    const [c1, c1b] = [accName('h1'), accName('h1b')]
    clones.push(c1, c1b)
    const first = await testing.cloneTemplateDatabase(c1, { baseUrl: BASE, set: 'wa', folders: { wa } })
    templates.add(first.name)
    expect(first.created).toBe(true)
    const again = await testing.cloneTemplateDatabase(c1b, { baseUrl: BASE, set: 'wa', folders: { wa } })
    expect(again).toMatchObject({ name: first.name, created: false })

    // muda o conteúdo de uma migração (sem mudar nome nem journal) → hash e modelo novos
    const last = readdirSync(wa).filter((f) => f.endsWith('.sql')).sort().at(-1)!
    appendFileSync(join(wa, last), `-- alterada ${Date.now()}\n`)
    const cloneB = accName('h2')
    clones.push(cloneB)
    const second = await testing.cloneTemplateDatabase(cloneB, { baseUrl: BASE, set: 'wa', folders: { wa } })
    templates.add(second.name)
    expect(second.name).not.toBe(first.name)
    expect(second.name).toMatch(/^crm_tpl_wa_[0-9a-f]{12}$/)
    expect(second.created).toBe(true)
    expect(dbFlags(first.name).exists).toBe(true)
    expect(sqlOk(dbUrl(cloneB), 'SELECT count(*) FROM drizzle.__drizzle_migrations;')[0]?.[0]).toBe(String(journalEntries('wa')))

    const only = new RegExp(`^(${first.name}|${second.name})$`)
    const res = await cleanupOrphanDatabases({ baseUrl: BASE, minAgeMs: 0, match: only, currentTemplates: [second.name] })
    expect(res.dropped).toEqual([first.name])
    expect(res.kept).toContainEqual({ name: second.name, reason: 'current' })
    expect(dbExists(first.name)).toBe(false)
    expect(dbFlags(second.name)).toEqual({ exists: true, template: true, allowConn: false })
  })

  it('AC-T128-03 modelo antigo COM conexão não é removido; sem a conexão, cai', async () => {
    const { cleanupOrphanDatabases } = await orphansMod()
    const wa = waFolderCopy('busy')
    const cb = accName('busy')
    clones.push(cb)
    const old = await testing.cloneTemplateDatabase(cb, { baseUrl: BASE, set: 'wa', folders: { wa } })
    templates.add(old.name)
    sqlOk(BASE, `ALTER DATABASE ${ident(old.name)} WITH ALLOW_CONNECTIONS true;`)
    const { createDb } = await import('@crm/db')
    const holder: Any = createDb(dbUrl(old.name), { max: 1 })
    await holder.$client.query('SELECT 1')
    try {
      const only = new RegExp(`^${old.name}$`)
      const busy = await cleanupOrphanDatabases({ baseUrl: BASE, minAgeMs: 0, match: only, currentTemplates: [] })
      expect(busy.dropped).toEqual([])
      expect(busy.kept).toContainEqual({ name: old.name, reason: 'active' })
      expect(dbExists(old.name)).toBe(true)
    } finally {
      await holder.$client.end()
    }
    const only = new RegExp(`^${old.name}$`)
    let res: Any
    for (let i = 0; i < 50; i++) {
      res = await cleanupOrphanDatabases({ baseUrl: BASE, minAgeMs: 0, match: only, currentTemplates: [] })
      if (!res.kept.some((k: Any) => k.reason === 'active')) break
      await new Promise((r) => setTimeout(r, 200)) // o backend some em instantes depois do end()
    }
    expect(res.dropped).toEqual([old.name])
    expect(dbExists(old.name)).toBe(false)
  })

  it('AC-T128-03 a limpeza de órfãos nunca escolhe o modelo do hash atual deste checkout (motivo "current")', async () => {
    // garante os modelos atuais de `wa` e `all`
    await temp({ migrate: true, set: 'wa' })
    await temp({ migrate: true })
    const { currentTemplateNames } = await templateDbMod()
    const current: string[] = currentTemplateNames()
    expect(current).toEqual(['all', 'wa', 'crm'].map((s) => testing.templateDatabaseName(s)))
    const { cleanupOrphanDatabases } = await orphansMod()
    // dryRun: nada é apagado; a decisão é a mesma do caminho real (padrão currentTemplates = hash atual)
    const res = await cleanupOrphanDatabases({ baseUrl: BASE, minAgeMs: 0, dryRun: true, match: new RegExp(`^(${current.join('|')})$`) })
    for (const n of current.slice(0, 2)) {
      expect(res.dropped).not.toContain(n)
      expect(res.kept).toContainEqual({ name: n, reason: 'current' })
      expect(dbFlags(n)).toMatchObject({ exists: true, template: true })
    }
    expect(res.dropped).toEqual([])
  })
})
