import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { DEFAULT_DATABASE_URL, migrateUrl, type MigrationSetOption } from './client.js'

// `@crm/db/testing` — bancos descartáveis para testes *.db.unit.test.ts e de aceitação (SPEC 3.10).

export interface TempDatabase {
  name: string
  url: string
  /** Remove o banco, derrubando conexões ainda abertas (`WITH (FORCE)`). Idempotente. */
  drop(): Promise<void>
}

export interface CreateTempDatabaseOptions {
  /** URL de um banco existente no mesmo servidor (padrão `DATABASE_URL`). */
  baseUrl?: string
  migrate?: boolean
  /** Conjunto de migrations aplicado quando `migrate` (padrão `all`). */
  set?: MigrationSetOption
  prefix?: string
}

export function randomDatabaseName(prefix = 'crm_test'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** URL igual à base, trocando só o nome do banco. */
export function withDatabase(baseUrl: string, database: string): string {
  const u = new URL(baseUrl)
  u.pathname = `/${database}`
  return u.toString()
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Cria um banco `crm_test_<rand>`, opcionalmente já migrado. */
export async function createTempDatabase(opts: CreateTempDatabaseOptions = {}): Promise<TempDatabase> {
  const baseUrl = opts.baseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const name = randomDatabaseName(opts.prefix)
  const url = withDatabase(baseUrl, name)
  const drop = () => adminQuery(baseUrl, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
  await adminQuery(baseUrl, `CREATE DATABASE ${quoteIdent(name)}`)
  if (opts.migrate) {
    try {
      await migrateUrl(url, { set: opts.set ?? 'all' })
    } catch (err) {
      await drop().catch(() => undefined)
      throw err
    }
  }
  return { name, url, drop }
}

async function adminQuery(baseUrl: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}
