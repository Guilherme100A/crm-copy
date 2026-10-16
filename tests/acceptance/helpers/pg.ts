// Acesso caixa-preta ao Postgres via `psql` (sem depender de driver na raiz).
// Bancos descartáveis por suíte (SPEC 3.10): createTempDb() → ... → dropTempDb().
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'

export const DEFAULT_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm'

/** Localiza o psql: CRM_PSQL, binários nativos (spec/INFRA.md), ou PATH. */
function psqlBin(): string {
  if (process.env.CRM_PSQL) return process.env.CRM_PSQL
  const tools = process.env.CRM_TOOLS ?? 'C:/Users/green/tools'
  for (const p of [`${tools}/pg/pgsql/bin/psql.exe`, `${tools}/pg/pgsql/bin/psql`, `${tools}/pg/bin/psql.exe`]) if (existsSync(p)) return p
  return 'psql'
}

export const dbUrl = (name: string, base = DEFAULT_DATABASE_URL) => {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

export interface SqlResult {
  code: number
  stdout: string
  stderr: string
  /** linhas do resultado (formato -At, colunas separadas por \x1f) */
  rows: string[][]
}

/** Executa SQL (via stdin) e nunca lança. ON_ERROR_STOP=1: erro → code != 0. */
export function sql(url: string, query: string): SqlResult {
  const res = spawnSync(psqlBin(), ['-X', '-q', '-A', '-t', '-F', '\x1f', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', '-'], {
    input: `\\set VERBOSITY verbose\n${query}`,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PGCONNECT_TIMEOUT: '10' },
  })
  const stdout = (res.stdout ?? '').replace(/\r/g, '')
  const stderr = `${res.stderr ?? ''}${res.error ? `\n[psql error] ${res.error.message}` : ''}`
  const rows = stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\x1f'))
  return { code: res.status ?? 1, stdout, stderr, rows }
}

/** Como sql(), mas lança com mensagem legível se der erro. */
export function sqlOk(url: string, query: string): string[][] {
  const r = sql(url, query)
  if (r.code !== 0) throw new Error(`SQL falhou (exit ${r.code}): ${r.stderr.trim()}\n--- query ---\n${query}`)
  return r.rows
}

export const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
export const ident = (v: string) => `"${v.replace(/"/g, '""')}"`

export interface TempDb {
  name: string
  url: string
}

export function createTempDb(prefix = 'crm_test'): TempDb {
  const name = `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  sqlOk(DEFAULT_DATABASE_URL, `CREATE DATABASE ${ident(name)};`)
  return { name, url: dbUrl(name) }
}

export function dropTempDb(db: TempDb | undefined) {
  if (!db) return
  sql(DEFAULT_DATABASE_URL, `DROP DATABASE IF EXISTS ${ident(db.name)} WITH (FORCE);`)
}

export function tableNames(url: string, schema = 'crm'): string[] {
  return sqlOk(url, `SELECT table_name FROM information_schema.tables WHERE table_schema = ${lit(schema)} AND table_type = 'BASE TABLE' ORDER BY 1;`).map((r) => r[0]!)
}

export interface ColumnInfo {
  name: string
  dataType: string
  udtName: string
  nullable: boolean
  default: string | null
}

export function columns(url: string, table: string, schema = 'crm'): ColumnInfo[] {
  return sqlOk(
    url,
    `SELECT column_name, data_type, udt_name, is_nullable, coalesce(column_default, '<<null>>')
       FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} ORDER BY ordinal_position;`,
  ).map(([name, dataType, udtName, nullable, def]) => ({
    name: name!,
    dataType: dataType!,
    udtName: udtName!,
    nullable: nullable === 'YES',
    default: def === '<<null>>' ? null : def!,
  }))
}

/** SQLSTATE de uma falha (ex.: 23505 unique_violation), extraído da saída verbose do psql. */
export function sqlState(r: SqlResult): string | undefined {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(r.stderr)?.[1]
}
