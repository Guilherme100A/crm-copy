// Apoio da suíte T20 (não é arquivo de teste). Superfície pública (fork 1:1 do ai-manager, combinada com o Operário):
// '@crm/wa-engine/send': SendPipeline, GATE_ORDER, SendRejectedError, ConsentService, createDeliver, bindTransportSession, AntibanBlockedError
// '@crm/wa-engine/health': computeHealthScore, healthLabel, HealthMonitor
// '@crm/wa-engine/queue' (T14): MessageQueue   '/safety': SessionLimitsService   '/antiban': createAntibanAdapter
// Infra (SPEC 3.10): Postgres descartável com migrations `wa`; Redis db 1 com prefixo BullMQ aleatório.
import { randomBytes } from 'node:crypto'
import { createTempDb, dropTempDb, lit, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const sendMod = (): Promise<any> => import('@crm/wa-engine/send')
export const healthMod = (): Promise<any> => import('@crm/wa-engine/health')
export const queueMod = (): Promise<any> => import('@crm/wa-engine/queue')
export const safetyMod = (): Promise<any> => import('@crm/wa-engine/safety')
export const antibanMod = (): Promise<any> => import('@crm/wa-engine/antiban')

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
  const tmp = createTempDb('crm_acc_t20')
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

const DAY = 24 * 60 * 60 * 1000

/** Sessão em public.sessions. Padrão: STABLE com warm-up concluído (sem limite de warm-up). */
export function newSession(url: string, opts: { status?: string; warmupDaysAgo?: number | null } = {}): string {
  const status = opts.status ?? 'STABLE'
  const days = opts.warmupDaysAgo === undefined ? 30 : opts.warmupDaysAgo
  const started = days === null ? 'NULL' : lit(new Date(Date.now() - days * DAY).toISOString())
  return sqlOk(
    url,
    `INSERT INTO public.sessions (name, status, warmup_started_at) VALUES (${lit(`t20-${rand(3)}`)}, ${lit(status)}, ${started}) RETURNING id;`,
  )[0]![0]!
}

export const sessionStatus = (url: string, id: string) => sqlOk(url, `SELECT status::text FROM public.sessions WHERE id = ${lit(id)};`)[0]![0]

/** Telefone E.164 único por teste. */
export const phone = () => `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`

export const textReq = (sessionId: string, to: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  phone: to,
  content: { text: `oi ${rand(2)}` },
  actor: 'crm:user-t20',
  ...extra,
})

/** Transporte mínimo controlável (o deliver real chama transport.sendMessage). */
export function fakeTransport() {
  let n = 0
  const failures: unknown[] = []
  const t = {
    sent: [] as Array<{ to: string; content: unknown }>,
    failNext(err: unknown) {
      failures.push(err)
    },
    async sendMessage(to: string, content: unknown) {
      const err = failures.shift()
      if (err) throw err
      t.sent.push({ to, content })
      return { messageId: `WAID-${++n}-${rand(2)}` }
    },
    async fetchGroups() {
      return []
    },
  }
  return t
}

export const FAST = { backoffDelayMs: 20, holdDelayMs: 20 }
