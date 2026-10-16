import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import * as schema from './schema/index.js'

export type Schema = typeof schema
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool }

// 127.0.0.1 e não localhost: no Windows o libpq perde ~2 s tentando ::1 (spec/INFRA.md).
export const DEFAULT_DATABASE_URL = 'postgres://wsm:wsm@127.0.0.1:5432/crm'

/**
 * Dois conjuntos independentes de migrations (SPEC T01):
 * - `wa`: tabelas `public.*` do WhatsApp, iguais às do ai-manager — controle em `drizzle.__drizzle_migrations`
 *   (mesmo lugar e mesma chave de lock do ai-manager, para os dois reconhecerem o mesmo histórico);
 * - `crm`: schema `crm` — controle dentro do próprio schema, em `crm.__drizzle_migrations`.
 */
export type MigrationSet = 'wa' | 'crm'
export type MigrationSetOption = MigrationSet | 'all'

interface MigrationSetConfig {
  folder: string
  migrationsSchema: string
  migrationsTable: string
  lockKey: number
}

// src/ e dist/ são irmãos de drizzle/, então o caminho relativo vale nos dois.
const drizzleDir = (set: MigrationSet) => fileURLToPath(new URL(`../drizzle/${set}`, import.meta.url))

export const MIGRATION_SETS: Record<MigrationSet, MigrationSetConfig> = {
  wa: { folder: drizzleDir('wa'), migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations', lockKey: 7_345_001 },
  crm: { folder: drizzleDir('crm'), migrationsSchema: 'crm', migrationsTable: '__drizzle_migrations', lockKey: 7_345_101 },
}

// Ordem fixa: `crm` pode referenciar `public.*`, nunca o contrário. Locks sempre adquiridos nessa ordem.
const ORDER: readonly MigrationSet[] = ['wa', 'crm']

export function migrationSets(set: MigrationSetOption): MigrationSet[] {
  return set === 'all' ? [...ORDER] : [set]
}

/** Pasta com ao menos uma migration no journal (o `wa` fica vazio até o T06). */
export function hasMigrations(folder: string): boolean {
  const journal = join(folder, 'meta', '_journal.json')
  if (!existsSync(journal)) return false
  const { entries } = JSON.parse(readFileSync(journal, 'utf8')) as { entries?: unknown[] }
  return (entries?.length ?? 0) > 0
}

export interface CreateDbOptions {
  max?: number
}

/** Cria o client Drizzle (node-postgres). `db.$client` é o Pool; feche com `db.$client.end()`. */
export function createDb(url: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, opts: CreateDbOptions = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 })
  return drizzle(pool, { schema }) as Database
}

export interface RunMigrationsOptions {
  set?: MigrationSetOption
  /** Só quando `runMigrations` recebe as opções sem `db`: banco alvo (padrão `DATABASE_URL`). */
  url?: string
  /** Sobrescreve as pastas (testes). */
  folders?: Partial<Record<MigrationSet, string>>
}

/**
 * Aplica as migrations pendentes do(s) conjunto(s). Idempotente.
 * Serializado por advisory lock porque api e worker migram ao subir.
 * Conjunto sem migrations geradas (sem `meta/_journal.json` ou com journal vazio) é ignorado.
 */
export async function runMigrations(db: Database, opts?: RunMigrationsOptions): Promise<void>
/** Forma curta: abre uma conexão própria em `url` (ou `opts.url` / `DATABASE_URL`), migra e fecha. */
export async function runMigrations(url: string, opts?: RunMigrationsOptions): Promise<void>
export async function runMigrations(opts?: RunMigrationsOptions): Promise<void>
export async function runMigrations(
  target?: Database | string | RunMigrationsOptions,
  maybeOpts: RunMigrationsOptions = {},
): Promise<void> {
  if (target === undefined || typeof target === 'string' || !('$client' in target)) {
    const opts = typeof target === 'object' ? target : maybeOpts
    const url = typeof target === 'string' ? target : (opts.url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
    return migrateUrl(url, opts)
  }
  return migrateDb(target, maybeOpts)
}

async function migrateDb(db: Database, opts: RunMigrationsOptions): Promise<void> {
  const sets = migrationSets(opts.set ?? 'all')
  const client = await db.$client.connect()
  const locked: number[] = []
  try {
    for (const set of sets) {
      const cfg = MIGRATION_SETS[set]
      await client.query('select pg_advisory_lock($1)', [cfg.lockKey])
      locked.push(cfg.lockKey)
    }
    for (const set of sets) {
      const cfg = MIGRATION_SETS[set]
      const migrationsFolder = opts.folders?.[set] ?? cfg.folder
      if (!hasMigrations(migrationsFolder)) continue
      await migrate(drizzle(client), {
        migrationsFolder,
        migrationsSchema: cfg.migrationsSchema,
        migrationsTable: cfg.migrationsTable,
      })
    }
  } finally {
    try {
      for (const key of locked.reverse()) await client.query('select pg_advisory_unlock($1)', [key])
    } finally {
      client.release()
    }
  }
}

/** Conveniência: conecta, migra e fecha. */
export async function migrateUrl(url: string, opts: RunMigrationsOptions = {}): Promise<void> {
  const db = createDb(url, { max: 1 })
  try {
    await migrateDb(db, opts)
  } finally {
    await db.$client.end()
  }
}
