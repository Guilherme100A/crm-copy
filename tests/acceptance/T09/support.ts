// Apoio da suíte T09 (não é arquivo de teste). Superfície pública usada:
// - '@crm/worker': StreamConsumer, startWorker; registry (apps/worker/src/registry.ts, ponto de registro): createRegistry.
// - '@crm/core': defineQueue, defineWorker.
// - '@crm/node-kit': redisConnection, bullConnection.  '@crm/db': createDb, runMigrations.
// Isolamento (SPEC 3.10): Redis db 1 com nomes de stream/fila aleatórios por teste; Postgres em banco descartável.
import { randomBytes } from 'node:crypto'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')

export async function worker(): Promise<any> {
  const mod: any = await import('@crm/worker')
  if (typeof mod.StreamConsumer !== 'function') throw new Error('@crm/worker não exporta StreamConsumer')
  return mod
}

export async function core(): Promise<any> {
  return import('@crm/core')
}

export async function kit(): Promise<any> {
  return import('@crm/node-kit')
}

export async function newRedis(): Promise<any> {
  const k = await kit()
  return k.redisConnection({ url: REDIS_URL })
}

/** Nomes isolados para um teste: stream de eventos e DLQ. */
export function names() {
  const id = rand()
  return { stream: `t09:${id}:wsm:events`, dlq: `t09:${id}:crm:wa-events:dlq`, group: 'crm', id }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condição'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(25)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}`)
}

/** Evento message.inbound válido (WaEvent v1, envelope snake_case com `at`). */
export function inbound(sessionId = `sess-${rand()}`, messageId = `MSG-${rand()}`, text = 'olá') {
  return {
    v: 1,
    type: 'message.inbound',
    session_id: sessionId,
    at: new Date().toISOString(),
    message: { id: messageId, from: '5511999998888@s.whatsapp.net', from_me: false, timestamp: Date.now(), type: 'conversation', text },
  }
}

export function sessionState(sessionId = `sess-${rand()}`) {
  return { v: 1, type: 'session.state', session_id: sessionId, at: new Date().toISOString(), from: 'WARMING', to: 'STABLE' }
}

export async function xadd(redis: any, stream: string, event: unknown): Promise<string> {
  return redis.xadd(stream, '*', 'event', JSON.stringify(event))
}

/** Quantidade de pendentes (entregues e não confirmados) do grupo. */
export async function pendingCount(redis: any, stream: string, group = 'crm'): Promise<number> {
  try {
    const r = await redis.xpending(stream, group)
    return Number(r?.[0] ?? 0)
  } catch {
    return 0
  }
}

/** Entradas de um stream como objetos { id, fields }. */
export async function readAll(redis: any, stream: string): Promise<Array<{ id: string; fields: Record<string, string> }>> {
  const rows: Array<[string, string[]]> = await redis.xrange(stream, '-', '+')
  return rows.map(([id, flat]) => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!
    return { id, fields }
  })
}

/** StreamConsumer com nomes isolados e reclaim curto (claimIdleMs configurável, conforme contrato do Operário). */
export async function newConsumer(redis: any, n: ReturnType<typeof names>, extra: Record<string, unknown> = {}) {
  const { StreamConsumer } = await worker()
  return new StreamConsumer({
    redis,
    stream: n.stream,
    group: n.group,
    dlqStream: n.dlq,
    claimIdleMs: 200,
    claimIntervalMs: 100,
    blockMs: 100,
    ...extra,
  })
}

export async function cleanupStreams(redis: any, n: ReturnType<typeof names>) {
  await redis.del(n.stream, n.dlq).catch(() => {})
}

export interface CrmDb {
  tmp: TempDb
  db: any
  close(): Promise<void>
}

/** Banco descartável com as migrations `crm` (inclui crm.processed_events). */
export async function migratedCrmDb(): Promise<CrmDb> {
  const mod: any = await import('@crm/db')
  const tmp = createTempDb('crm_acc_t09')
  const db = mod.createDb(tmp.url)
  await mod.runMigrations(db, { set: 'crm' })
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
