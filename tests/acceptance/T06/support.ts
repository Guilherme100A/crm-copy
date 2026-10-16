// Apoio da suíte T06 (não é arquivo de teste). Contratos usados:
// - @crm/db: createDb(url) → Database (db.$client = pg.Pool); runMigrations(db, { set: 'wa' }).
// - @crm/wa-engine: usePostgresAuthState(db, sessionId) → { state: { creds, keys: { get, set } }, saveCreds, clear? },
//   cifrado com a CREDENTIALS_KEY do ambiente (AES-256-GCM, @crm/node-kit).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootPath } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, sqlOk, type TempDb } from '../helpers/pg'

// Chave de teste própria da suíte (32 bytes base64), definida antes de qualquer uso do cifrador.
process.env.CREDENTIALS_KEY = randomBytes(32).toString('base64')

export async function loadDb(): Promise<any> {
  const mod: any = await import('@crm/db')
  if (typeof mod.createDb !== 'function' || typeof mod.runMigrations !== 'function')
    throw new Error('@crm/db não exporta createDb/runMigrations')
  return mod
}

/** usePostgresAuthState pela entrada pública de @crm/wa-engine (ou subpath ./auth-state, se declarado). */
export async function loadAuthState(): Promise<(db: any, sessionId: string, opts?: any) => Promise<any>> {
  const main: any = await import('@crm/wa-engine')
  if (typeof main.usePostgresAuthState === 'function') return main.usePostgresAuthState
  const dir = rootPath('packages', 'wa-engine')
  const exp = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).exports?.['./auth-state']
  const target = typeof exp === 'string' ? exp : (exp?.development ?? exp?.import ?? exp?.default)
  const file = target ? resolve(dir, target) : resolve(dir, 'src', 'auth-state', 'index.ts')
  if (existsSync(file)) {
    const sub: any = await import(pathToFileURL(file).href)
    if (typeof sub.usePostgresAuthState === 'function') return sub.usePostgresAuthState
  }
  throw new Error('@crm/wa-engine não exporta usePostgresAuthState')
}

export const poolOf = (db: any): any => db?.$client ?? db?.pool ?? db?.client

export async function closeDb(db: any) {
  const pool = poolOf(db)
  if (pool && typeof pool.end === 'function') {
    pool.on?.('error', () => {})
    await pool.end().catch(() => {})
  }
}

export interface WaDb {
  tmp: TempDb
  db: any
  close(): Promise<void>
}

/** Banco descartável com as migrations `wa` aplicadas e um Database aberto. */
export async function migratedWaDb(prefix = 'crm_acc_t06'): Promise<WaDb> {
  const mod = await loadDb()
  const tmp = createTempDb(prefix)
  const db = mod.createDb(tmp.url)
  try {
    await mod.runMigrations(db, { set: 'wa' })
  } catch (e) {
    await closeDb(db)
    dropTempDb(tmp)
    throw e
  }
  return {
    tmp,
    db,
    close: async () => {
      await closeDb(db)
      dropTempDb(tmp)
    },
  }
}

/** Cria uma linha em public.sessions (FK de session_credentials) e devolve o id. */
export function newSession(url: string, name = `t06-${randomBytes(3).toString('hex')}`): string {
  return sqlOk(url, `INSERT INTO public.sessions (name) VALUES (${lit(name)}) RETURNING id;`)[0]![0]!
}

/** Converte valores (Buffer/Uint8Array, objetos proto) numa forma comparável: bytes → hex, só chaves próprias definidas. */
export function norm(v: any): any {
  if (v === null || v === undefined) return v
  if (v instanceof Uint8Array) return `hex:${Buffer.from(v).toString('hex')}`
  if (Array.isArray(v)) return v.map(norm)
  if (typeof v === 'object') {
    if (typeof v.toNumber === 'function' && 'low' in v && 'high' in v) return v.toNumber() // Long
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined && v[k] !== null) out[k] = norm(v[k])
    return out
  }
  return v
}

export const bytes = (n = 32) => randomBytes(n)

export function credRowCount(url: string, sessionId: string, keyType?: string, keyId?: string): number {
  const where = [`session_id = ${lit(sessionId)}`]
  if (keyType) where.push(`key_type = ${lit(keyType)}`)
  if (keyId) where.push(`key_id = ${lit(keyId)}`)
  return Number(sqlOk(url, `SELECT count(*) FROM public.session_credentials WHERE ${where.join(' AND ')};`)[0]![0])
}
