// Apoio da suíte T14 (não é arquivo de teste). Superfície pública (subpaths de @crm/wa-engine):
// - '/queue': MessageQueue({ db, connection, prefix, getTransport, deliver, antiban?, maxAttempts, backoffDelayMs, holdDelayMs })
// - '/antiban': createAntibanAdapter, antibanModeFromEnv, antibanPresetFromEnv, AntibanConfigError
// - '/warmup': warmupDailyLimit, computeWarmup, DEFAULT_WARMUP_SCHEDULE
// - '/safety': SessionLimitsService, FORBIDDEN_REDUCTION_FACTOR
// Infra (SPEC 3.10): Postgres em banco descartável migrado (`wa`), Redis db 1 com prefixo BullMQ aleatório.
import { randomBytes } from 'node:crypto'
import { createTempDb, dropTempDb, lit, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const queueMod = (): Promise<any> => import('@crm/wa-engine/queue')
export const antibanMod = (): Promise<any> => import('@crm/wa-engine/antiban')
export const warmupMod = (): Promise<any> => import('@crm/wa-engine/warmup')
export const safetyMod = (): Promise<any> => import('@crm/wa-engine/safety')

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = 'condição'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(25)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}`)
}

export interface WaDb {
  tmp: TempDb
  db: any
  close(): Promise<void>
}

export async function migratedWaDb(): Promise<WaDb> {
  const mod: any = await import('@crm/db')
  const tmp = createTempDb('crm_acc_t14')
  const db = mod.createDb(tmp.url)
  await mod.runMigrations(db, { set: 'wa' })
  return {
    tmp,
    db,
    close: async () => {
      const pool = db?.$client
      pool?.on?.('error', () => {})
      await pool?.end?.().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

/** Sessão em public.sessions (tabela com o schema do ai-manager). */
export function newSession(url: string, opts: { status?: string; warmupStartedAt?: Date | null } = {}): string {
  const status = opts.status ?? 'STABLE'
  const started = opts.warmupStartedAt === undefined ? 'NULL' : opts.warmupStartedAt === null ? 'NULL' : lit(opts.warmupStartedAt.toISOString())
  return sqlOk(
    url,
    `INSERT INTO public.sessions (name, status, warmup_started_at) VALUES (${lit(`t14-${rand(3)}`)}, ${lit(status)}, ${started}) RETURNING id;`,
  )[0]![0]!
}

/** Transporte mínimo (só precisa existir: o envio passa pelo `deliver` injetado). */
export function fakeTransport() {
  let n = 0
  return {
    sent: [] as Array<{ to: string; content: unknown }>,
    async sendMessage(to: string, content: unknown) {
      this.sent.push({ to, content })
      return { messageId: `WAID-${++n}-${rand(2)}` }
    },
  }
}

export const FAST = { backoffDelayMs: 20, holdDelayMs: 20 }

export const textMsg = (sessionId: string, text = `oi ${rand(2)}`) => ({ sessionId, phone: '+5511988887777', content: { text } })
