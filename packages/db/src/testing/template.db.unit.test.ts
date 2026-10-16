// T128: banco-modelo por hash das migrações com Postgres real. O AC-T128-01 usa o modelo `all` atual; os demais criam
// modelos do conjunto `wa` (pequeno: menos escrita, e o DROP de bancos no Windows espera um checkpoint que fica caro
// com muita página suja) a partir de uma cópia da pasta `wa` com um comentário aleatório (hash próprio deste arquivo),
// para não mexer no modelo atual dos outros worktrees. O código é o mesmo para qualquer conjunto.
import { randomBytes } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_DATABASE_URL, MIGRATION_SETS, migrateUrl } from '../client'
import { createTempDatabase, randomDatabaseName, withDatabase, type TempDatabase } from '../testing'
import {
  cloneTemplateDatabase,
  dropTemplateDatabases,
  ensureTemplateDatabase,
  templateDatabaseName,
  type MigrationFolders,
} from './template'

const baseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
const orphansUrl = new URL('../../../../scripts/e2e/orphans.mjs', import.meta.url).href
const tag = randomBytes(4).toString('hex')
const dirs: string[] = []
const temps: TempDatabase[] = []
const templates = new Set<string>()

async function query<T extends pg.QueryResultRow>(url: string, text: string, values?: unknown[]): Promise<T[]> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return (await c.query<T>(text, values)).rows
  } finally {
    await c.end()
  }
}
const dbRow = async (name: string) =>
  (
    await query<{ datistemplate: boolean; datallowconn: boolean }>(
      baseUrl,
      'select datistemplate, datallowconn from pg_database where datname = $1',
      [name],
    )
  )[0]

/** Pastas com uma cópia de `wa` cujo último `.sql` ganha um comentário: hash (e modelo) próprio. */
function variant(label: string): MigrationFolders {
  const dir = mkdtempSync(join(tmpdir(), `t128-${label}-`))
  dirs.push(dir)
  cpSync(MIGRATION_SETS.wa.folder, dir, { recursive: true })
  const last = join(
    dir,
    readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .at(-1)!,
  )
  writeFileSync(last, `${readFileSync(last, 'utf8')}\n-- t128 ${tag} ${label}\n`)
  const folders = { wa: dir }
  templates.add(templateDatabaseName('wa', folders))
  return folders
}

async function clone(folders: MigrationFolders, extra: { cache?: boolean } = {}) {
  const name = randomDatabaseName('crm_test_t128')
  const r = await cloneTemplateDatabase(name, { baseUrl, set: 'wa', folders, ...extra })
  temps.push({
    name,
    url: withDatabase(baseUrl, name),
    drop: () => query(baseUrl, `DROP DATABASE IF EXISTS "${name}"`).then(() => undefined),
  })
  return { ...r, db: name }
}

/** Tabelas, colunas, índices e restrições de `crm`, `public` e `drizzle`. */
async function schemaOf(url: string) {
  const schemas = ['crm', 'public', 'drizzle']
  return {
    columns: await query(
      url,
      `select table_schema, table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
       from information_schema.columns where table_schema = any($1) order by 1, 2, 4`,
      [schemas],
    ),
    indexes: await query(
      url,
      'select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname = any($1) order by 1, 2, 3',
      [schemas],
    ),
    constraints: await query(
      url,
      `select n.nspname, c.conrelid::regclass::text as rel, c.conname, pg_get_constraintdef(c.oid) as def
       from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = any($1) order by 1, 2, 3`,
      [schemas],
    ),
    migrations: await query(url, 'select hash, created_at from crm.__drizzle_migrations order by id'),
  }
}

afterAll(async () => {
  for (const t of temps) await t.drop().catch(() => undefined)
  await dropTemplateDatabases(baseUrl, [...templates]).catch(() => undefined)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
}, 60_000)

describe('AC-T128-01 createTempDatabase({ migrate: true }) clona o modelo', () => {
  it('mesmo schema que a migração completa; da segunda chamada em diante nenhuma migração roda', async () => {
    const first = await createTempDatabase({ migrate: true })
    temps.push(first)
    const second = await createTempDatabase({ migrate: true })
    temps.push(second)
    const tpl = templateDatabaseName('all')
    expect(first.template?.name).toBe(tpl)
    expect(second.template).toEqual({ name: tpl, created: false })
    expect(await dbRow(tpl)).toEqual({ datistemplate: true, datallowconn: false })

    const full = await createTempDatabase()
    temps.push(full)
    await migrateUrl(full.url, { set: 'all' })

    const [a, b] = await Promise.all([schemaOf(second.url), schemaOf(full.url)])
    expect(a.columns.length).toBeGreaterThan(100)
    expect(a.indexes.length).toBeGreaterThan(10)
    expect(a.columns).toEqual(b.columns)
    expect(a.indexes).toEqual(b.indexes)
    expect(a.constraints).toEqual(b.constraints)
    expect(a.migrations).toEqual(b.migrations)
  })

  it('CRM_TEST_TEMPLATE=0 volta à migração completa (sem modelo)', async () => {
    const prev = process.env.CRM_TEST_TEMPLATE
    process.env.CRM_TEST_TEMPLATE = '0'
    try {
      const t = await createTempDatabase({ migrate: true, set: 'wa' })
      temps.push(t)
      expect(t.template).toBeUndefined()
      expect((await query(t.url, 'select count(*)::int as n from drizzle.__drizzle_migrations'))[0]).toMatchObject({
        n: expect.any(Number),
      })
    } finally {
      if (prev === undefined) delete process.env.CRM_TEST_TEMPLATE
      else process.env.CRM_TEST_TEMPLATE = prev
    }
  })
})

// Dois modelos próprios do arquivo (cada um custa uma migração completa; a máquina é compartilhada): A nasce no teste
// de concorrência, B no do 3D000; o AC-T128-03 usa os dois como hash antigo (A) e novo (B).
let a: MigrationFolders | undefined
let b: MigrationFolders | undefined
const variantA = () => (a ??= variant('a'))
const variantB = () => (b ??= variant('b'))

describe('AC-T128-02 concorrência', () => {
  it('oito clones simultâneos (cada um com a sua conexão de lock, como processos distintos): modelo criado uma vez', async () => {
    const folders = variantA()
    const name = templateDatabaseName('wa', folders)
    expect(await dbRow(name)).toBeUndefined()
    const results = await Promise.all(Array.from({ length: 8 }, () => clone(folders, { cache: false })))
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.name))).toEqual(new Set([name]))
    for (const r of results) {
      const rows = await query<{ n: number }>(
        withDatabase(baseUrl, r.db),
        "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
      )
      expect(rows[0]!.n).toBeGreaterThan(5)
    }
    expect(await dbRow(name)).toEqual({ datistemplate: true, datallowconn: false })
  }, 120_000)

  it('sessão aberta na origem (55006): o clone tenta de novo e conclui quando ela fecha', async () => {
    const folders = variantA()
    const { name } = await ensureTemplateDatabase({ baseUrl, set: 'wa', folders })
    await query(baseUrl, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`)
    const holder = new pg.Client({ connectionString: withDatabase(baseUrl, name) })
    await holder.connect()
    await query(baseUrl, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`)
    const t0 = Date.now()
    const closing = new Promise<void>((r) => setTimeout(() => void holder.end().then(r), 500))
    const r = await clone(folders, { cache: false })
    await closing
    expect(r.created).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
  }, 60_000)

  it('modelo removido por baixo (3D000): refaz o modelo e clona', async () => {
    const folders = variantB()
    const first = await clone(folders)
    const name = first.name
    await query(baseUrl, `ALTER DATABASE "${name}" WITH IS_TEMPLATE false`)
    await query(baseUrl, `DROP DATABASE "${name}"`)
    const again = await clone(folders) // o cache do processo ainda acha que o modelo existe
    expect(again).toMatchObject({ name, created: true })
  }, 60_000)
})

describe('AC-T128-03 hash novo e limpeza de órfãos', () => {
  it('migração alterada → modelo novo; a limpeza remove o antigo sem conexões e nunca o do hash atual', async () => {
    const oldFolders = variantA()
    const newFolders = variantB()
    const oldName = templateDatabaseName('wa', oldFolders)
    const newName = templateDatabaseName('wa', newFolders)
    expect(newName).not.toBe(oldName)
    expect((await clone(oldFolders)).name).toBe(oldName)
    expect((await clone(newFolders)).name).toBe(newName)

    const { cleanupOrphanDatabases } = (await import(orphansUrl)) as {
      cleanupOrphanDatabases(
        o: Record<string, unknown>,
      ): Promise<{ dropped: string[]; kept: { name: string; reason: string }[] }>
    }
    const match = new RegExp(`^(${oldName}|${newName})$`)
    const res = await cleanupOrphanDatabases({ baseUrl, minAgeMs: 0, match, currentTemplates: [newName] })
    expect(res.dropped).toEqual([oldName])
    expect(res.kept).toEqual([{ name: newName, reason: 'current' }])
    expect(await dbRow(oldName)).toBeUndefined()
    expect(await dbRow(newName)).toEqual({ datistemplate: true, datallowconn: false })

    // Sem `currentTemplates`, os atuais são os do checkout (pastas reais): o modelo `all` atual nunca cai.
    const current = templateDatabaseName('all')
    const def = await cleanupOrphanDatabases({ baseUrl, minAgeMs: 0, match: new RegExp(`^${current}$`) })
    expect(def.dropped).toEqual([])
    expect(await dbRow(current)).toMatchObject({ datistemplate: true })
  }, 120_000)
})
