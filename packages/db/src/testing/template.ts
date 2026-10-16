import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { MIGRATION_SETS, migrateUrl, migrationSets, type MigrationSet, type MigrationSetOption } from '../client.js'

// T128: banco-modelo por hash das migrações. Migrar todas as migrações a cada banco descartável custava ~1,4 s por banco
// (e cada subida do harness E2E); agora o primeiro processo migra um `crm_tpl_<set>_<hash12>` e todos clonam com
// `CREATE DATABASE … TEMPLATE`. Regras e como forçar a recriação em docs/testing.md.
// O hash tem uma cópia em JS puro (scripts/e2e/template-db.mjs, usada pela limpeza de órfãos); as duas são comparadas
// em template.db.unit.test.ts.

export const TEMPLATE_PREFIX = 'crm_tpl_'
/** Classe do advisory lock de dois inteiros `(classe, hashtext(nome do modelo))`, no banco `postgres`. */
export const TEMPLATE_LOCK_CLASS = 7_345_128
/** Banco onde o lock é tomado: advisory locks valem por banco, então todos os processos usam o mesmo. */
export const TEMPLATE_LOCK_DATABASE = 'postgres'

export type MigrationFolders = Partial<Record<MigrationSet, string>>

const normalize = (text: string) => text.replace(/\r\n/g, '\n')

/**
 * SHA-256 (hex) do conjunto: para cada pasta do conjunto, o `meta/_journal.json` e os `.sql` (nome e conteúdo, em ordem
 * de nome). Fim de linha normalizado: o mesmo commit em checkouts com CRLF e LF dá o mesmo modelo.
 */
export function migrationsHash(set: MigrationSetOption = 'all', folders: MigrationFolders = {}): string {
  const h = createHash('sha256')
  for (const s of migrationSets(set)) {
    const folder = folders[s] ?? MIGRATION_SETS[s].folder
    h.update(`set:${s}\n`)
    const journal = join(folder, 'meta', '_journal.json')
    h.update(existsSync(journal) ? normalize(readFileSync(journal, 'utf8')) : '<sem journal>')
    h.update('\n')
    const files = existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => f.endsWith('.sql'))
          .sort()
      : []
    for (const f of files) h.update(`file:${f}\n${normalize(readFileSync(join(folder, f), 'utf8'))}\n`)
  }
  return h.digest('hex')
}

/** `crm_tpl_<set>_<12 primeiros hex do hash>`. */
export function templateDatabaseName(set: MigrationSetOption = 'all', folders: MigrationFolders = {}): string {
  return `${TEMPLATE_PREFIX}${set}_${migrationsHash(set, folders).slice(0, 12)}`
}

/** Usar o modelo? `CRM_TEST_TEMPLATE=0` volta à migração completa em cada banco (diagnóstico). */
export function templatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRM_TEST_TEMPLATE !== '0'
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pgCode = (err: unknown) => (err as { code?: string } | null)?.code

function withDatabase(baseUrl: string, database: string): string {
  const u = new URL(baseUrl)
  u.pathname = `/${database}`
  return u.toString()
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

interface DbState {
  template: boolean
  connections: number
}

async function dbState(c: pg.Client, name: string): Promise<DbState | null> {
  const r = await c.query<{ template: boolean; connections: number }>(
    `select d.datistemplate as template, (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as connections
     from pg_database d where d.datname = $1`,
    [name],
  )
  return r.rows[0] ?? null
}

export interface EnsureTemplateOptions {
  /** URL de um banco do servidor (padrão `DATABASE_URL`); só host, porta e credenciais importam. */
  baseUrl: string
  set?: MigrationSetOption
  folders?: MigrationFolders
  /** Espera máxima, depois de migrar, pelo fim das conexões do modelo (padrão 10 s). */
  idleWaitMs?: number
  /** `false` ignora o cache do processo e vai ao servidor (testes do lock entre processos). */
  cache?: boolean
}

export interface EnsureTemplateResult {
  name: string
  /** `true` só no processo que criou e migrou o modelo nesta chamada. */
  created: boolean
}

/** Modelos já vistos prontos neste processo (pula a consulta e o lock); invalidado se o clone não achar o modelo. */
const ready = new Map<string, Promise<EnsureTemplateResult>>()

/**
 * Garante o modelo do conjunto: existe e está `IS_TEMPLATE true` / `ALLOW_CONNECTIONS false`. Idempotente entre
 * processos: a criação é serializada por `pg_advisory_lock` no banco `postgres` (o primeiro cria e migra; os demais
 * esperam o lock e reaproveitam). Um banco com o nome do modelo que não é modelo é sobra de um criador que morreu
 * no meio (o lock dele caiu junto): é removido e refeito.
 */
export function ensureTemplateDatabase(opts: EnsureTemplateOptions): Promise<EnsureTemplateResult> {
  const name = templateDatabaseName(opts.set ?? 'all', opts.folders)
  if (opts.cache === false) return buildTemplate(name, opts)
  const key = `${new URL(opts.baseUrl).host}/${name}`
  const cached = ready.get(key)
  // Quem pega a promessa de outra chamada não criou nada, mesmo que aquela tenha criado.
  if (cached) return cached.then((r) => ({ name: r.name, created: false }))
  const p = buildTemplate(name, opts)
  ready.set(key, p)
  p.catch(() => ready.delete(key))
  return p
}

function forgetTemplate(baseUrl: string, name: string): void {
  ready.delete(`${new URL(baseUrl).host}/${name}`)
}

async function buildTemplate(name: string, opts: EnsureTemplateOptions): Promise<EnsureTemplateResult> {
  const lockUrl = withDatabase(opts.baseUrl, TEMPLATE_LOCK_DATABASE)
  // Caminho rápido: o modelo já existe (o caso comum), sem lock.
  const pre = await withClient(lockUrl, (c) => dbState(c, name))
  if (pre?.template) return { name, created: false }
  return withClient(lockUrl, async (c) => {
    await c.query('select pg_advisory_lock($1, hashtext($2))', [TEMPLATE_LOCK_CLASS, name])
    try {
      const state = await dbState(c, name)
      if (state?.template) return { name, created: false }
      if (state) await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`)
      await c.query(`CREATE DATABASE ${quoteIdent(name)}`)
      try {
        await migrateUrl(withDatabase(opts.baseUrl, name), { set: opts.set ?? 'all', folders: opts.folders })
        await c.query(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
      } catch (err) {
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).catch(() => undefined)
        throw err
      }
      // O pool da migração já recebeu end(), mas o backend no servidor some em instantes: espera para o primeiro
      // clone não esbarrar em 55006 (o clone ainda tenta de novo, isto só evita a espera lá).
      const deadline = Date.now() + (opts.idleWaitMs ?? 10_000)
      while (((await dbState(c, name))?.connections ?? 0) > 0 && Date.now() < deadline) await sleep(50)
      return { name, created: true }
    } finally {
      await c.query('select pg_advisory_unlock($1, hashtext($2))', [TEMPLATE_LOCK_CLASS, name]).catch(() => undefined)
    }
  })
}

export interface CloneTemplateOptions extends EnsureTemplateOptions {
  /** Prazo para as novas tentativas quando o Postgres recusa a cópia por sessão na origem (55006). Padrão 15 s. */
  retryMs?: number
}

export interface CloneTemplateResult extends EnsureTemplateResult {
  /** Tempo da clonagem (ms), sem contar a criação do modelo. */
  cloneMs: number
}

/**
 * Cria `name` como cópia do modelo do conjunto (garantindo o modelo antes). 55006 ("source database is being accessed
 * by other users") → nova tentativa curta até `retryMs`; modelo sumido (3D000, removido pela limpeza de órfãos entre
 * a checagem e o clone) → refaz o modelo e tenta de novo.
 */
export async function cloneTemplateDatabase(name: string, opts: CloneTemplateOptions): Promise<CloneTemplateResult> {
  const lockUrl = withDatabase(opts.baseUrl, TEMPLATE_LOCK_DATABASE)
  let tpl = await ensureTemplateDatabase(opts)
  let created = tpl.created
  const deadline = Date.now() + (opts.retryMs ?? 15_000)
  let rebuilt = false
  let wait = 50
  for (;;) {
    const t0 = Date.now()
    try {
      await withClient(lockUrl, (c) => c.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(tpl.name)}`))
      return { name: tpl.name, created, cloneMs: Date.now() - t0 }
    } catch (err) {
      const code = pgCode(err)
      if (code === '3D000' && !rebuilt) {
        rebuilt = true
        forgetTemplate(opts.baseUrl, tpl.name)
        tpl = await ensureTemplateDatabase(opts)
        created ||= tpl.created
        continue
      }
      if (code !== '55006' || Date.now() > deadline) throw err
      await sleep(wait)
      wait = Math.min(wait * 2, 500)
    }
  }
}

/**
 * Remove modelos (força a recriação na próxima chamada). Sem `names`: os do hash atual dos três conjuntos. Toma o lock
 * de cada modelo (não remove um modelo no meio da criação) e tira o `IS_TEMPLATE` antes do DROP. Devolve os removidos.
 */
export async function dropTemplateDatabases(baseUrl: string, names?: string[]): Promise<string[]> {
  const targets = names ?? (['all', 'wa', 'crm'] as const).map((s) => templateDatabaseName(s))
  const dropped: string[] = []
  await withClient(withDatabase(baseUrl, TEMPLATE_LOCK_DATABASE), async (c) => {
    for (const name of targets) {
      if (!name.startsWith(TEMPLATE_PREFIX)) throw new Error(`não é um banco-modelo: ${name}`)
      await c.query('select pg_advisory_lock($1, hashtext($2))', [TEMPLATE_LOCK_CLASS, name])
      try {
        if (!(await dbState(c, name))) continue
        await c.query(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false`)
        await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
        dropped.push(name)
      } finally {
        await c.query('select pg_advisory_unlock($1, hashtext($2))', [TEMPLATE_LOCK_CLASS, name])
      }
      forgetTemplate(baseUrl, name)
    }
  })
  return dropped
}
