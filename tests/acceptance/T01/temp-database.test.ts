// AC-T01-04: createTempDatabase({ migrate: true }) (@crm/db/testing) devolve banco migrado `crm_test_<rand>`
// e drop() o remove mesmo com conexões abertas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DATABASE_URL, ident, sql, tableNames } from '../helpers'
import { BASE_TABLES, databaseExists, loadDb, loadTesting, poolOf, type DbModule } from './support'

let mod: DbModule
let testing: any
const leftovers: string[] = []

/** Nome do banco a partir do retorno (campo `name` ou caminho da `url`). */
function dbName(t: any): string {
  if (typeof t?.name === 'string' && t.name) return t.name
  if (typeof t?.url === 'string') return decodeURIComponent(new URL(t.url).pathname.slice(1))
  throw new Error(`createTempDatabase devolveu objeto sem name/url: ${JSON.stringify(Object.keys(t ?? {}))}`)
}

function dbUrlOf(t: any): string {
  if (typeof t?.url === 'string') return t.url
  const u = new URL(DEFAULT_DATABASE_URL)
  u.pathname = `/${dbName(t)}`
  return u.toString()
}

beforeAll(async () => {
  mod = await loadDb()
  testing = await loadTesting()
})

afterAll(() => {
  for (const n of leftovers) sql(DEFAULT_DATABASE_URL, `DROP DATABASE IF EXISTS ${ident(n)} WITH (FORCE);`)
})

describe('@crm/db/testing createTempDatabase', () => {
  it('AC-T01-04 createTempDatabase({ migrate: true }) devolve banco crm_test_<rand> já migrado', async () => {
    const t = await testing.createTempDatabase({ migrate: true })
    const name = dbName(t)
    leftovers.push(name)
    expect(name).toMatch(/^crm_test_[A-Za-z0-9_]+$/)
    expect(databaseExists(name)).toBe(true)
    const tables = tableNames(dbUrlOf(t), 'crm')
    for (const b of BASE_TABLES) expect(tables, `crm.${b} ausente no banco temporário`).toContain(b)
    expect(typeof t.drop).toBe('function')
    await t.drop()
    expect(databaseExists(name), 'drop() não removeu o banco').toBe(false)
  })

  it('AC-T01-04 bancos temporários têm nomes distintos', async () => {
    const [a, b] = await Promise.all([testing.createTempDatabase({ migrate: true }), testing.createTempDatabase({ migrate: true })])
    leftovers.push(dbName(a), dbName(b))
    expect(dbName(a)).not.toBe(dbName(b))
    await Promise.all([a.drop(), b.drop()])
  })

  it('AC-T01-04 drop() remove o banco mesmo com conexões abertas (pool ocioso e cliente em uso)', async () => {
    const t = await testing.createTempDatabase({ migrate: true })
    const name = dbName(t)
    leftovers.push(name)

    const db = mod.createDb(dbUrlOf(t))
    const pool = poolOf(db)
    pool.on('error', () => {})
    // várias conexões abertas: uma retida (checked-out) e outras ociosas no pool
    const held = await pool.connect()
    held.on('error', () => {})
    await held.query('select 1')
    await Promise.all([pool.query('select 1'), pool.query('select 1')])
    const open = Number(sql(DEFAULT_DATABASE_URL, `SELECT count(*) FROM pg_stat_activity WHERE datname = '${name}';`).rows[0]?.[0])
    expect(open, 'pré-condição: deveria haver conexões abertas').toBeGreaterThan(0)

    try {
      await t.drop()
      expect(databaseExists(name), 'drop() não removeu o banco com conexões abertas').toBe(false)
    } finally {
      try {
        held.release(true)
      } catch {
        /* conexão já encerrada pelo servidor */
      }
      await pool.end().catch(() => {})
    }
  })
})
