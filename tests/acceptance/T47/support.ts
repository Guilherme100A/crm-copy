// Ambiente da suíte T47 (não é arquivo de teste). Contrato combinado com a Bigorna:
// - '@crm/worker': createRegistry, registerConnectionsConsumer(registry, deps), startWorker, WA_EVENT_FIELD.
//   deps = { db, publisher, mailer, appName, now, alertWindowMs }.
// - Entrega pelo stream real (XADD num stream aleatório, grupo aleatório), como o consumidor de chats.
// - Publicação pelo RealtimePublisher REAL (@crm/core) com prefixo aleatório: valida o catálogo SSE e os eventos
//   ficam legíveis por XRANGE em `<prefix>:<companyId>`.
// - E-mail no MemoryMailer (@crm/node-kit). Relógio injetável (`now`) para o dedupe de 5 s.
// Banco descartável migrado (SPEC 3.10); Redis db 1.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { fakeEmail, fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const APP_NAME = 'ProdutoTesteT47'
export const ALERT_WINDOW_MS = 5_000
export const rand = (n = 4) => randomBytes(n).toString('hex')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v) return v as T
    } catch (err) {
      last = err
    }
    await sleep(50)
  }
  throw new Error(`timeout (${timeoutMs} ms) esperando ${what}${last ? `: ${String(last)}` : ''}`)
}

export interface RtEvent {
  id: string
  type: string
  company_id: string
  data: Any
}

export interface Company {
  id: string
  owner: string
  admin: string
  member: string
}

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  mailer: MemoryMailer
  rtPrefix: string
  stream: string
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  /** Relógio injetado no consumidor (ms). */
  clock: { ms: number }
  advance(ms: number): void
  iso(): string
  /** Empresa com owner, admin e member (e-mails ligados por padrão). */
  newCompany(settings?: Record<string, unknown>): Promise<Company>
  newConnection(companyId: string, opts?: { name?: string; phone?: string | null }): Promise<{ id: string; sessionId: string; name: string; phone: string | null }>
  /** XADD do WaEvent no stream do consumidor; `at` padrão = relógio atual. */
  emit(event: Record<string, unknown>): Promise<void>
  connectionEvent(sessionId: string, state: 'open' | 'close', extra?: Record<string, unknown>): Promise<void>
  /** Eventos SSE publicados para a empresa (stream do RealtimePublisher). */
  events(companyId: string, type?: string, connectionId?: string): Promise<RtEvent[]>
  /** Todas as chaves de stream criadas pelo publisher desta suíte. */
  rtKeys(): Promise<string[]>
  row(connectionId: string): Promise<Any>
  close(): Promise<void>
}

export async function startEnv(): Promise<Env> {
  const worker: Any = await import('@crm/worker')
  const core: Any = await import('@crm/core')
  for (const name of ['createRegistry', 'registerConnectionsConsumer', 'startWorker'])
    if (typeof worker[name] !== 'function') throw new Error(`@crm/worker não exporta ${name}`)
  if (typeof core.RealtimePublisher !== 'function') throw new Error('@crm/core não exporta RealtimePublisher')

  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  const mailer = new MemoryMailer({ from: 'no-reply@t47.test' })
  const rtPrefix = `t47:${rand()}:crm:rt`
  const stream = `t47:${rand()}:wsm:events`
  const publisher = new core.RealtimePublisher({ redis, prefix: rtPrefix })
  const clock = { ms: Date.parse('2026-10-16T12:00:00.000Z') }
  const now = () => new Date(clock.ms)
  const field = worker.WA_EVENT_FIELD ?? 'event'
  let app: Any

  const close = async () => {
    await app?.stop?.().catch(() => {})
    const keys: string[] = await redis.keys(`${rtPrefix}*`).catch(() => [])
    if (keys.length) await redis.del(...keys).catch(() => {})
    await redis.del(stream).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }

  try {
    const registry = worker.createRegistry()
    worker.registerConnectionsConsumer(registry, { db, publisher, mailer, appName: APP_NAME, now, alertWindowMs: ALERT_WINDOW_MS })
    app = await worker.startWorker({
      registry,
      db,
      redis,
      consumer: { stream, group: `g-t47-${rand()}`, blockMs: 50 },
      handleSignals: false,
      exitProcess: false,
    })
  } catch (err) {
    await close().catch(() => {})
    throw err
  }

  const env: Env = {
    tmp,
    db,
    redis,
    mailer,
    rtPrefix,
    stream,
    q,
    clock,
    advance: (ms) => {
      clock.ms += ms
    },
    iso: () => new Date(clock.ms).toISOString(),
    async newCompany(settings = {}) {
      const [c] = await q(`INSERT INTO crm.companies (name, slug, settings) VALUES ($1, $2, $3::jsonb) RETURNING id`, [
        `Empresa ${rand(2)}`,
        uniqueId('t47'),
        JSON.stringify(settings),
      ])
      const user = async (role: string) => {
        const email = fakeEmail(`t47-${role}`)
        const [u] = await q(`INSERT INTO crm.users (email, password_hash, name) VALUES ($1, 'x', $2) RETURNING id`, [email, `Usuário ${role}`])
        await q(`INSERT INTO crm.company_members (company_id, user_id, role) VALUES ($1, $2, $3)`, [c.id, u.id, role])
        return email
      }
      return { id: c.id, owner: await user('owner'), admin: await user('admin'), member: await user('member') }
    },
    async newConnection(companyId, opts = {}) {
      const sessionId = `t47-sess-${rand(6)}`
      const name = opts.name ?? `Conexão ${rand(3)}`
      const phone = opts.phone === undefined ? fakePhone() : opts.phone
      const [r] = await q(`INSERT INTO crm.connections (company_id, session_id, name, phone_number) VALUES ($1, $2, $3, $4) RETURNING id`, [
        companyId,
        sessionId,
        name,
        phone,
      ])
      return { id: r.id, sessionId, name, phone }
    },
    async emit(event) {
      await redis.xadd(stream, '*', field, JSON.stringify({ v: 1, at: env.iso(), ...event }))
    },
    async connectionEvent(sessionId, state, extra = {}) {
      await env.emit({ type: 'session.connection', session_id: sessionId, state, ...extra })
    },
    async events(companyId, type, connectionId) {
      const rows: Array<[string, string[]]> = await redis.xrange(`${rtPrefix}:${companyId}`, '-', '+')
      return rows
        .map(([id, flat]) => {
          const f: Record<string, string> = {}
          for (let i = 0; i + 1 < flat.length; i += 2) f[flat[i]!] = flat[i + 1]!
          return { id, type: f.type!, company_id: f.company_id!, data: f.data ? JSON.parse(f.data) : null }
        })
        .filter((e) => (!type || e.type === type) && (!connectionId || e.data?.connection_id === connectionId))
    },
    async rtKeys() {
      return redis.keys(`${rtPrefix}*`)
    },
    async row(connectionId) {
      const [r] = await q(`SELECT * FROM crm.connections WHERE id = $1`, [connectionId])
      return r
    },
    close,
  }
  return env
}

/** Abre a conexão (como o engine: session.state WARMING alguns ms ANTES do session.connection open) e espera o efeito. */
export async function openConnection(env: Env, conn: { id: string; sessionId: string }, companyId: string) {
  const before = (await env.events(companyId, 'connection.connected', conn.id)).length
  await env.emit({ type: 'session.state', session_id: conn.sessionId, from: 'NEW', to: 'WARMING' })
  await sleep(15)
  env.advance(20)
  await env.connectionEvent(conn.sessionId, 'open')
  await waitFor(async () => (await env.events(companyId, 'connection.connected', conn.id)).length > before, `connection.connected de ${conn.id}`)
  await waitFor(async () => (await env.row(conn.id))?.connection_state === 'open', `connection_state=open em ${conn.id}`)
}

/** Fecha a conexão e espera o `connection.disconnected` correspondente (o n-ésimo). */
export async function closeConnection(env: Env, conn: { id: string; sessionId: string }, companyId: string, extra: Record<string, unknown> = {}) {
  const before = (await env.events(companyId, 'connection.disconnected', conn.id)).length
  await env.connectionEvent(conn.sessionId, 'close', { reason: 'transient', status_code: 428, ...extra })
  await waitFor(async () => (await env.events(companyId, 'connection.disconnected', conn.id)).length > before, `connection.disconnected de ${conn.id}`)
}

/** Destinatários (minúsculos) de uma mensagem do MemoryMailer, aceitando string, lista ou objetos `{ address }`. */
export function recipients(m: Any): string[] {
  const flat = (v: Any): string[] =>
    v == null ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? flat(v.address ?? v.email) : String(v).split(',').map((s) => s.trim())
  return [...flat(m.to), ...flat(m.cc), ...flat(m.bcc)]
    .map((s) => (/<([^>]+)>/.exec(s)?.[1] ?? s).toLowerCase())
    .filter(Boolean)
}

/** E-mails que citam a conexão (pelo nome) no assunto ou no corpo. */
export function mailsAbout(mailer: MemoryMailer, connName: string): Any[] {
  return (mailer.messages as Any[]).filter((m) => [m.subject, m.text, m.html].some((s) => typeof s === 'string' && s.includes(connName)))
}

/** Flow + contato + chat na conexão + run no status pedido. Devolve os ids. */
export async function seedRun(env: Env, companyId: string, connectionId: string, status: 'waiting' | 'running', flowId?: string) {
  const flow = flowId ?? (await env.q(`INSERT INTO crm.flows (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, `Fluxo ${rand(2)}`]))[0].id
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Lead ${rand(2)}`, fakePhone()])
  const [chat] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [companyId, connectionId, contact.id])
  const wait = status === 'waiting' ? JSON.stringify({ kind: 'reply', handles: {}, deadline_at: null }) : null
  const [run] = await env.q(
    `INSERT INTO crm.flow_runs (company_id, flow_id, contact_id, chat_id, status, wait) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [companyId, flow, contact.id, chat.id, status, wait],
  )
  return { flowId: flow as string, contactId: contact.id as string, chatId: chat.id as string, runId: run.id as string }
}
