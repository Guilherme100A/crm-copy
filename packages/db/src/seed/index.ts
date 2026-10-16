// Seeds do CRM (T17): seed-base + registro de seeds por módulo aplicados em ordem determinística (AC-T17-05)
// e `resetDatabase` para o `/__e2e/reset` (esvazia as tabelas sem refazer as migrations).
import { sql } from 'drizzle-orm'
import { hashPassword } from '@crm/node-kit'
import type { Database } from '../client.js'
import { seedBase } from './base.js'
import { SEED_MODULES } from './modules/index.js'

export * from './base.js'

export interface SeedContext {
  db: Database
  /** Hash de senha no formato do login (scrypt do @crm/node-kit), memorizado por senha. */
  passwordHash(plain: string): Promise<string>
}

export interface SeedModule {
  /** Único. */
  name: string
  /** Menor roda antes. Default 100; empate desempatado pelo nome. */
  order?: number
  run(ctx: SeedContext): Promise<void> | void
}

export const DEFAULT_SEED_ORDER = 100
export const BASE_SEED_NAME = 'base'

const registered = new Map<string, SeedModule>()

/** Registra um seed de módulo; devolve a função que o remove. Nome repetido → erro. */
export function registerSeedModule(module: SeedModule): () => void {
  if (!module.name || module.name === BASE_SEED_NAME) throw new Error(`nome de seed inválido: "${module.name}"`)
  if (registered.has(module.name)) throw new Error(`seed "${module.name}" já registrado`)
  registered.set(module.name, module)
  return () => {
    if (registered.get(module.name) === module) registered.delete(module.name)
  }
}

const byOrder = (a: SeedModule, b: SeedModule) =>
  (a.order ?? DEFAULT_SEED_ORDER) - (b.order ?? DEFAULT_SEED_ORDER) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** Seeds de módulo na ordem em que rodam (sem o `base`, que sempre vem primeiro). */
export function listSeedModules(): { name: string; order: number }[] {
  return [...registered.values()].sort(byOrder).map((m) => ({ name: m.name, order: m.order ?? DEFAULT_SEED_ORDER }))
}

for (const m of SEED_MODULES) registerSeedModule(m)

export interface RunSeedsOptions {
  /** Default: os registrados (`registerSeedModule` + `seed/modules`). */
  modules?: SeedModule[]
  /** Roda o seed-base antes. Default true. */
  base?: boolean
}

/** Aplica o seed-base e os módulos em ordem determinística; devolve os nomes na ordem aplicada. */
export async function runSeeds(db: Database, opts: RunSeedsOptions = {}): Promise<{ applied: string[] }> {
  const hashes = new Map<string, Promise<string>>()
  const ctx: SeedContext = {
    db,
    passwordHash: (plain) => {
      let h = hashes.get(plain)
      if (!h) hashes.set(plain, (h = hashPassword(plain)))
      return h
    },
  }
  const applied: string[] = []
  if (opts.base !== false) {
    await seedBase(ctx)
    applied.push(BASE_SEED_NAME)
  }
  const modules = [...(opts.modules ?? registered.values())].sort(byOrder)
  for (const m of modules) {
    await m.run(ctx)
    applied.push(m.name)
  }
  return { applied }
}

/** Schemas/tabelas preservados no reset: controle das migrations. */
const KEEP = new Set(['crm.__drizzle_migrations', 'drizzle.__drizzle_migrations'])

/**
 * Esvazia todas as tabelas de `crm` e `public` (menos o controle de migrations) e reinicia as sequências delas: o mesmo
 * estado final de `TRUNCATE … RESTART IDENTITY CASCADE`.
 *
 * T126: um único comando com um `DELETE` por tabela (CTEs) em vez do TRUNCATE. As FKs são checadas no fim do comando,
 * então a ordem não importa. O TRUNCATE recria os arquivos de cada tabela e índice, e o build de cada btree faz fsync
 * imediato (PG 16): centenas de fsyncs por reset, que sob disco disputado levaram o reset de ~1 s a 13–27 s. O DELETE
 * só grava WAL. As sequências próprias das tabelas (serial/identity) voltam ao início com `setval(…, start, false)`,
 * o mesmo estado que o RESTART IDENTITY deixa.
 */
export async function resetDatabase(db: Database): Promise<string[]> {
  const res = await db.execute<{ t: string }>(sql`
    select quote_ident(table_schema) || '.' || quote_ident(table_name) as t
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema in ('crm', 'public')`)
  const tables = res.rows.map((r) => r.t).filter((t) => !KEEP.has(t.replace(/"/g, '')))
  if (!tables.length) return tables
  const regclasses = tables.map((t) => `'${t.replace(/'/g, "''")}'::regclass`).join(', ')
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`with ${tables.map((t, i) => `d${i} as (delete from ${t})`).join(', ')} select 1`))
      await tx.execute(
        sql.raw(`
          select setval(s.seqrelid, s.seqstart, false)
          from pg_sequence s
          join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = s.seqrelid
            and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
          where d.refobjid in (${regclasses})`),
      )
    })
  } catch {
    // Algo que o DELETE não cobre (ex.: trigger novo que recusa a remoção): o TRUNCATE deixa o mesmo estado, só mais lento.
    await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`))
  }
  return tables
}

/** Reset completo do banco de teste: esvazia e roda os seeds. */
export async function resetAndSeed(db: Database, opts: RunSeedsOptions = {}): Promise<{ applied: string[] }> {
  await resetDatabase(db)
  return runSeeds(db, opts)
}
