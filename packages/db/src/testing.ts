import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import { DEFAULT_DATABASE_URL, migrateUrl, type MigrationSetOption } from './client.js'
import { cloneTemplateDatabase, templatesEnabled } from './testing/template.js'

export * from './testing/template.js'

// `@crm/db/testing` — bancos descartáveis para testes *.db.unit.test.ts e de aceitação (SPEC 3.10), e o prefixo de
// filas BullMQ por arquivo de teste (T126). Regras em docs/testing.md.

export interface TempDatabase {
  name: string
  url: string
  /**
   * T128: modelo de onde o banco foi clonado (`migrate` com modelos ligados). `created` só quando esta chamada criou e
   * migrou o modelo; nas demais nenhuma migração rodou.
   */
  template?: { name: string; created: boolean }
  /**
   * Remove o banco depois que as conexões dele terminam (T126: espera até `dropWaitMs`). Conexão ainda viva ao fim da
   * espera → o banco NÃO é removido (sem `WITH (FORCE)`, que dispararia 57P01 em pools/workers ainda em uso) e fica para
   * a limpeza de órfãos (`scripts/e2e/orphans.mjs`), com um aviso do processo. Idempotente.
   */
  drop(): Promise<void>
}

export interface CreateTempDatabaseOptions {
  /** URL de um banco existente no mesmo servidor (padrão `DATABASE_URL`). */
  baseUrl?: string
  migrate?: boolean
  /** Conjunto de migrations aplicado quando `migrate` (padrão `all`). */
  set?: MigrationSetOption
  prefix?: string
  /** Espera máxima, no `drop()`, pelo fim das conexões do banco (padrão 15 s). */
  dropWaitMs?: number
}

export const DEFAULT_DROP_WAIT_MS = 15_000

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

/**
 * Cria um banco `crm_test_<rand>`, opcionalmente já migrado. T128: com `migrate`, clona o banco-modelo do conjunto
 * (`crm_tpl_<set>_<hash12>`, criado e migrado uma vez por hash das migrações) em vez de rodar as migrações;
 * `CRM_TEST_TEMPLATE=0` volta à migração completa.
 */
export async function createTempDatabase(opts: CreateTempDatabaseOptions = {}): Promise<TempDatabase> {
  const baseUrl = opts.baseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  const name = randomDatabaseName(opts.prefix)
  const url = withDatabase(baseUrl, name)
  const drop = () => dropWhenIdle(baseUrl, name, opts.dropWaitMs ?? DEFAULT_DROP_WAIT_MS)
  if (opts.migrate && templatesEnabled()) {
    const tpl = await cloneTemplateDatabase(name, { baseUrl, set: opts.set ?? 'all' })
    return { name, url, drop, template: { name: tpl.name, created: tpl.created } }
  }
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

/** Conexões abertas no banco (fora a do próprio administrador). */
export async function databaseConnections(baseUrl: string, name: string): Promise<number> {
  const client = new pg.Client({ connectionString: baseUrl })
  await client.connect()
  try {
    const r = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name])
    return r.rows[0]?.n ?? 0
  } finally {
    await client.end()
  }
}

/**
 * DROP sem FORCE quando o banco fica sem conexões (pools que acabaram de receber `end()` terminam em instantes).
 * Se sobrar conexão viva no fim da espera, o banco fica (órfão para a limpeza) em vez de derrubar quem o usa.
 */
async function dropWhenIdle(baseUrl: string, name: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const open = await databaseConnections(baseUrl, name)
    if (open === 0) {
      try {
        await adminQuery(baseUrl, `DROP DATABASE IF EXISTS ${quoteIdent(name)}`)
        return
      } catch (err) {
        // 55006 (object_in_use): alguém conectou entre a contagem e o DROP; tenta de novo dentro da janela.
        if ((err as { code?: string }).code !== '55006' || Date.now() > deadline) throw err
      }
    } else if (Date.now() > deadline) {
      process.emitWarning(`banco temporário ${name} mantido: ${open} conexão(ões) ainda aberta(s) após ${waitMs} ms (feche pools/workers antes do drop)`, 'TempDatabaseWarning')
      return
    }
    await new Promise((r) => setTimeout(r, 100))
  }
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

// ---------------------------------------------------------------- filas por arquivo de teste (T126)

/** Prefixos de fila BullMQ efetivos neste processo de teste. */
export function testQueuePrefix(env: NodeJS.ProcessEnv = process.env): { crm: string | undefined; wa: string | undefined } {
  return { crm: env.CRM_QUEUE_PREFIX, wa: env.WA_QUEUE_PREFIX }
}

/**
 * Torna `CRM_QUEUE_PREFIX`/`WA_QUEUE_PREFIX` únicos POR ARQUIVO de teste: `<prefixo da execução>-f<hash do arquivo>-<rand>`.
 * Chamado pelo `src/test-setup.ts` de cada pacote (setupFiles roda antes de cada arquivo, com `expect.getState().testPath`
 * já definido). O prefixo da execução vem do `vitest.config.ts` (T121); sem ele, `crm-t-<pid>` / `wsm-t-<pid>`.
 * Idempotente no mesmo arquivo.
 */
export function isolateTestQueues(testPath: string | undefined, env: NodeJS.ProcessEnv = process.env): { crm: string; wa: string } {
  const hash = createHash('sha1')
    .update(testPath ?? `pid-${process.pid}`)
    .digest('hex')
    .slice(0, 8)
  const tag = `-f${hash}-`
  const keep = (v: string | undefined) => (v && v.includes(tag) ? v : null)
  const rand = randomBytes(2).toString('hex')
  const crm = keep(env.CRM_QUEUE_PREFIX) ?? `${env.CRM_QUEUE_PREFIX?.trim() || `crm-t-${process.pid}`}${tag}${rand}`
  const wa = keep(env.WA_QUEUE_PREFIX) ?? `${env.WA_QUEUE_PREFIX?.trim() || `wsm-t-${process.pid}`}${tag}${rand}`
  env.CRM_QUEUE_PREFIX = crm
  env.WA_QUEUE_PREFIX = wa
  return { crm, wa }
}
