// Apoio dos testes de T01: acesso ao contrato público de @crm/db e utilidades SQL caixa-preta.
// Contrato (SPEC T01): createDb(url) → Database (node-postgres Pool); runMigrations(db, { set: 'wa' | 'crm' | 'all' });
// @crm/db/testing: createTempDatabase({ migrate }) → { name/url, drop() }.
import { randomBytes } from 'node:crypto'
import { DEFAULT_DATABASE_URL, ident, lit, sql, sqlOk, type SqlResult } from '../helpers'

/** As 8 tabelas-base do schema `crm` (SPEC T01). */
export const BASE_TABLES = [
  'api_tokens',
  'audit_logs',
  'auth_sessions',
  'companies',
  'company_members',
  'password_resets',
  'platform_settings',
  'users',
] as const

/** Colunas citadas explicitamente na SPEC T01 para as tabelas-base. */
export const REQUIRED_COLUMNS: Record<string, string[]> = {
  companies: ['id', 'name', 'slug', 'active', 'time_zone', 'settings', 'deactivated_at'],
  users: ['id', 'email', 'password_hash', 'name', 'system_role', 'locale', 'avatar_key', 'last_company_id', 'referral_code'],
  company_members: ['company_id', 'user_id', 'role', 'permission_keys'],
}

export type MigrationSet = 'wa' | 'crm' | 'all'

export interface DbModule {
  createDb: (url: string, ...rest: any[]) => any
  runMigrations: (db: any, opts: { set: MigrationSet }) => Promise<unknown>
}

export async function loadDb(): Promise<DbModule> {
  const mod: any = await import('@crm/db')
  if (typeof mod.createDb !== 'function') throw new Error('@crm/db não exporta createDb')
  if (typeof mod.runMigrations !== 'function') throw new Error('@crm/db não exporta runMigrations')
  return mod as DbModule
}

export async function loadTesting(): Promise<any> {
  const mod: any = await import('@crm/db/testing')
  if (typeof mod.createTempDatabase !== 'function') throw new Error('@crm/db/testing não exporta createTempDatabase')
  return mod
}

/** Pool subjacente do Database (`db.$client` no drizzle node-postgres). */
export function poolOf(db: any): any {
  return db?.$client ?? db?.pool ?? db?.client
}

export async function closeDb(db: any) {
  const pool = poolOf(db)
  if (pool && typeof pool.end === 'function') {
    pool.on?.('error', () => {})
    await pool.end().catch(() => {})
  }
}

/** Abre um Database na URL, executa e fecha. */
export async function withDb<T>(mod: DbModule, url: string, fn: (db: any) => Promise<T>): Promise<T> {
  const db = mod.createDb(url)
  poolOf(db)?.on?.('error', () => {})
  try {
    return await fn(db)
  } finally {
    await closeDb(db)
  }
}

export async function migrate(mod: DbModule, url: string, set: MigrationSet) {
  await withDb(mod, url, (db) => mod.runMigrations(db, { set }))
}

export const randomText = (prefix = 't') => `${prefix}_${randomBytes(5).toString('hex')}`

export function databaseExists(name: string): boolean {
  return sqlOk(DEFAULT_DATABASE_URL, `SELECT 1 FROM pg_database WHERE datname = ${lit(name)};`).length > 0
}

/** Tabelas cujo nome indica controle de migrations, por schema. */
export function migrationTables(url: string): { schema: string; table: string }[] {
  return sqlOk(
    url,
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name ILIKE '%migration%' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2;`,
  ).map(([schema, table]) => ({ schema: schema!, table: table! }))
}

export function rowCount(url: string, schema: string, table: string): number {
  return Number(sqlOk(url, `SELECT count(*) FROM ${ident(schema)}.${ident(table)};`)[0]![0])
}

interface ColMeta {
  name: string
  udt: string
  dataType: string
  required: boolean
}

function colMeta(url: string, table: string, schema = 'crm'): ColMeta[] {
  return sqlOk(
    url,
    `SELECT column_name, udt_name, data_type, (is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO')
       FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)} ORDER BY ordinal_position;`,
  ).map(([name, udt, dataType, required]) => ({ name: name!, udt: udt!, dataType: dataType!, required: required === 't' }))
}

/** Valor SQL plausível para coluna obrigatória não informada pelo teste. */
function fillerFor(url: string, c: ColMeta): string {
  const u = c.udt
  if (u === 'uuid') return 'gen_random_uuid()'
  if (['text', 'varchar', 'bpchar', 'citext', 'name'].includes(u)) {
    if (u === 'bpchar') return lit(randomBytes(2).toString('hex').slice(0, 3).toUpperCase())
    return lit(randomText(c.name))
  }
  if (['int2', 'int4', 'int8', 'numeric', 'float4', 'float8'].includes(u)) return '0'
  if (u === 'bool') return 'false'
  if (['timestamptz', 'timestamp', 'date'].includes(u)) return 'now()'
  if (u === 'jsonb' || u === 'json') return `'{}'`
  if (u === 'bytea') return `'\\x00'::bytea`
  if (u.startsWith('_')) return `'{}'`
  const label = sqlOk(url, `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = ${lit(u)} ORDER BY e.enumsortorder LIMIT 1;`)
  if (label.length) return lit(label[0]![0]!)
  throw new Error(`não sei preencher a coluna obrigatória ${c.name} (${u})`)
}

/**
 * INSERT em crm.<table> com os valores dados (já em SQL ou string literal) e preenchimento
 * automático das colunas obrigatórias sem default. Devolve o resultado cru (não lança).
 */
export function tryInsert(url: string, table: string, values: Record<string, string>, returning = 'id'): SqlResult {
  const cols = colMeta(url, table)
  if (!cols.length) throw new Error(`tabela crm.${table} não existe`)
  const out: Record<string, string> = {}
  for (const c of cols) {
    if (c.name in values) out[c.name] = values[c.name]!
    else if (c.required) out[c.name] = fillerFor(url, c)
  }
  const names = Object.keys(out)
  const ret = cols.some((c) => c.name === returning) ? ` RETURNING ${ident(returning)}` : ''
  return sql(url, `INSERT INTO crm.${ident(table)} (${names.map(ident).join(', ')}) VALUES (${names.map((n) => out[n]).join(', ')})${ret};`)
}

export function insertOk(url: string, table: string, values: Record<string, string>): string {
  const r = tryInsert(url, table, values)
  if (r.code !== 0) throw new Error(`INSERT em crm.${table} falhou: ${r.stderr.trim()}`)
  return r.rows[0]?.[0] ?? ''
}

/** Valor de enum/text para um papel (role) da coluna, como literal SQL. */
export const role = (r: 'owner' | 'admin' | 'member') => lit(r)
