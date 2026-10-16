// Ambiente da suíte T33 (contrato combinado com o Fole):
// - Porta: new ChatIngest({ db, publisher, waGateway, resolveConnection, onInbound }) de '@crm/core'; await handle(event).
// - Ponta a ponta: createRegistry + registerChatsConsumer (@crm/worker) + startWorker com stream/grupo aleatórios no Redis db 1.
// - Sessão → empresa/conexão por resolver injetado (crm.connections chega na T40). Empresa criada por SQL.
// - Publisher fake (publish(companyId, type, data)) e FakeWaGateway (consentimento e opt-out).
import { randomBytes, randomUUID } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'
export const rand = (n = 4) => randomBytes(n).toString('hex')

export interface Published {
  companyId: string
  type: string
  data: Any
}

export interface Env {
  tmp: TempDatabase
  db: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    q,
    close: async () => {
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

/** Uma empresa com uma conexão (sessão do WhatsApp), ingest próprio, publisher e gateway fakes. */
export async function tenant(env: Env, settings: Record<string, unknown> = {}) {
  const [row] = await env.q(`INSERT INTO crm.companies (name, slug, settings) VALUES ($1, $2, $3) RETURNING id`, [
    `Empresa T33 ${rand()}`,
    `t33-${rand()}`,
    JSON.stringify(settings),
  ])
  const companyId: string = row.id
  const connectionId = randomUUID()
  const sessionId = `sess-${rand()}`
  const published: Published[] = []
  const inbound: Any[] = []
  const gateway = new FakeWaGateway()
  const sessions = new Map([[sessionId, { companyId, connectionId }]])
  const deps = {
    db: env.db,
    publisher: {
      async publish(cid: string, type: string, data: Any) {
        published.push({ companyId: cid, type, data })
      },
    },
    waGateway: gateway,
    resolveConnection: async (sid: string) => sessions.get(sid) ?? null,
    onInbound: (e: Any) => void inbound.push(e),
  }
  const core: Any = await import('@crm/core')
  if (typeof core.ChatIngest !== 'function') throw new Error('@crm/core não exporta ChatIngest')
  const ingest = new core.ChatIngest(deps)
  const types = (t?: string) => published.filter((p) => !t || p.type === t)
  return { companyId, connectionId, sessionId, published, types, inbound, gateway, deps, ingest, handle: (e: Any) => ingest.handle(e) }
}
export type Tenant = Awaited<ReturnType<typeof tenant>>

/** Telefone fictício (+5511 9xxxx-xxxx) e o JID correspondente. */
export function phone() {
  const e164 = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  return { e164, jid: `${e164.slice(1)}@s.whatsapp.net` }
}
export const lidJid = () => `${String(Math.floor(Math.random() * 1e15)).padStart(15, '1')}@lid`

export function inboundEvent(sessionId: string, message: Record<string, unknown>) {
  return {
    v: 1,
    type: 'message.inbound',
    session_id: sessionId,
    at: new Date().toISOString(),
    message: { id: `WAMSG-${rand(6)}`, from_me: false, timestamp: Date.now(), type: 'conversation', text: 'olá', ...message },
  }
}

export function statusEvent(sessionId: string, messageId: string, status: string, transportId?: string) {
  return { v: 1, type: 'message.status', session_id: sessionId, at: new Date().toISOString(), message_id: messageId, transport_message_id: transportId ?? null, status }
}

export function lidMappingEvent(sessionId: string, lid: string, pn: string) {
  return { v: 1, type: 'contact.lid_mapping', session_id: sessionId, at: new Date().toISOString(), lid, pn }
}

export function historyEvent(sessionId: string, messages: Array<Record<string, unknown>>) {
  return {
    v: 1,
    type: 'history.batch',
    session_id: sessionId,
    at: new Date().toISOString(),
    messages: messages.map((m) => ({ id: `WAHIST-${rand(6)}`, from_me: false, timestamp: Date.now() - 86_400_000, type: 'conversation', text: 'antiga', ...m })),
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = 'condição'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(50)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}`)
}

/** Worker real (consumidor do stream) com o consumer de chats registrado. */
export async function startChatsWorker(env: Env, t: Tenant) {
  const w: Any = await import('@crm/worker')
  const kit: Any = await import('@crm/node-kit')
  for (const n of ['createRegistry', 'registerChatsConsumer', 'startWorker'])
    if (typeof w[n] !== 'function') throw new Error(`@crm/worker não exporta ${n} (exports: ${Object.keys(w).join(', ')})`)
  const redis = kit.redisConnection({ url: REDIS_URL })
  redis.on?.('error', () => {})
  const stream = `t33:${rand()}:wsm:events`
  const group = `t33-${rand()}`
  const reg = w.createRegistry()
  w.registerChatsConsumer(reg, t.deps)
  const handle = await w.startWorker({ registry: reg, db: env.db, redis, consumer: { stream, group, blockMs: 100 }, handleSignals: false, exitProcess: false })
  return {
    stream,
    xadd: (event: unknown) => redis.xadd(stream, '*', 'event', JSON.stringify(event)),
    stop: async () => {
      await (handle?.stop?.() ?? handle?.close?.())?.catch?.(() => {})
      await redis.del(stream).catch(() => {})
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    },
  }
}
