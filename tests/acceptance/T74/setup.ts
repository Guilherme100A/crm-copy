// Ambiente da suíte T74. Contrato combinado com o Operário (Bigorna):
// '@crm/core': prepareMassDispatch(deps, id), runMassDispatchTick(deps, { dispatchId, targetId }), variantForContact(db, contactId),
//   isWithinWindow/nextAllowedTime; deps = { db, wa, schedule, publisher, now, rng, retryDelayMs, pausedRecheckMs, control? }.
// Disparos criados pela API da T60 (POST /api/mass-dispatches). Nada de BullMQ: o teste chama prepare/tick e captura schedule.
// crm.connections.session_id é único global (T40): cada conexão do teste tem sessão própria no FakeWaGateway.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  wa: Any
  jobs: { prepared: string[]; cancelled: string[] }
  publisher: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const pubRedis = redisConnection()
  pubRedis.on?.('error', () => {})
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    for (const r of [redis, pubRedis]) await Promise.resolve(r.quit?.()).catch(() => r.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const wa = new FakeWaGateway()
    const jobs = { prepared: [] as string[], cancelled: [] as string[] }
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: wa,
      massDispatchJobs: {
        enqueuePrepare: async (id: string) => void jobs.prepared.push(id),
        cancel: async (id: string) => void jobs.cancelled.push(id),
      },
      // disparo manual de fluxo (T43) sem fila real
      flowStepEnqueue: async () => {},
      trustProxy: true,
    })
    const publisher = new core.RealtimePublisher({ redis: pubRedis })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, wa, jobs, publisher, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

function client(env: Env): ApiClient {
  const ip = randomIp()
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface User {
  c: ApiClient
  userId: string
  companyId: string
  token: string
}

export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t74')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t74')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id, token: c.cookies.get('crm_session')! }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null, role: 'member' | 'admin' = 'member'): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Conexão com sessão própria no FakeWaGateway (`state = null` → sessão inexistente no gateway). */
export async function newConnection(env: Env, companyId: string, state: 'STABLE' | 'WARMING' | 'DISCONNECTED' | 'NEW' | null = 'STABLE') {
  const sessionId = `sess-t74-${uniqueId('s').toLowerCase()}`
  if (state) env.wa.addSession({ id: sessionId, state })
  const name = `Número ${uniqueId('n')}`
  const [r] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, $3) RETURNING id`, [companyId, sessionId, name])
  return { id: r.id as string, sessionId, name }
}

const usedPhones = new Set<string>()
export function mobile(): string {
  for (;;) {
    const p = `+5511977${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`
    if (!usedPhones.has(p)) {
      usedPhones.add(p)
      return p
    }
  }
}

let clock = Date.parse('2026-01-01T00:00:00Z')
export interface ContactSeed {
  name?: string
  phone?: string | null
  lid?: string | null
  optOut?: boolean
  origin?: string
  consent?: boolean
}
/** Contato com created_at crescente (a ordem de agendamento é created_at asc). */
export async function newContact(env: Env, companyId: string, s: ContactSeed = {}): Promise<string> {
  clock += 60_000
  const [r] = await env.q(
    `INSERT INTO crm.contacts (company_id, name, phone_e164, wa_lid, opt_out, created_at, origin, consent, consent_source)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 'manual'), $8, $9) RETURNING id`,
    [
      companyId,
      s.name ?? uniqueId('Contato'),
      s.phone === undefined ? mobile() : s.phone,
      s.lid ?? null,
      s.optOut ?? false,
      new Date(clock).toISOString(),
      s.origin ?? null,
      s.consent ?? false,
      s.consent ? (s.origin ?? 'manual') : null,
    ],
  )
  return r.id
}

export async function newLabel(env: Env, companyId: string, name = uniqueId('Etq')): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`, [companyId, name])
  return r.id
}
export const labelContact = (env: Env, companyId: string, contactId: string, labelId: string) =>
  env.q(`INSERT INTO crm.contact_labels (company_id, contact_id, label_id) VALUES ($1, $2, $3)`, [companyId, contactId, labelId])

const flowDef = () => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
    { id: 'm1', type: 'message', name: 'Oi', position: { x: 200, y: 0 }, actions: [{ id: 'm1-a1', type: 'send_message', order: 0, config: { message_text: 'Olá {first_name}' } }] },
  ],
  edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm1' }],
  variables: [],
  refs: {},
})

/** Fluxo pela API (T28): `active` publica e ativa; `paused` ativa e pausa; `draft` só cria. */
export async function newFlow(u: User, status: 'active' | 'paused' | 'draft' = 'active') {
  const res = await u.c.post('/api/flows', { name: uniqueId('Fluxo') })
  if (res.status !== 201) throw new Error(`POST /api/flows → ${res.status} ${res.text}`)
  const flow = res.body.flow
  const put = await u.c.put(`/api/flows/${flow.id}/definition`, flowDef())
  if (put.status !== 200) throw new Error(`PUT definition → ${put.status} ${put.text}`)
  if (status !== 'draft') {
    const act = await u.c.post(`/api/flows/${flow.id}/activate`)
    if (act.status !== 200) throw new Error(`activate → ${act.status} ${act.text}`)
  }
  if (status === 'paused') {
    const p = await u.c.post(`/api/flows/${flow.id}/pause`)
    if (p.status !== 200) throw new Error(`pause → ${p.status} ${p.text}`)
  }
  return flow as { id: string; name: string }
}

export interface Base {
  manifest: Any
  targets: Array<{ connection_id: string; flow_id: string }>
  weekdays: number[]
  window_start: string
  window_end: string
  interval_min_seconds: number
  interval_max_seconds: number
  [k: string]: unknown
}

export const body = (targets: Base['targets'], manifest: Any, extra: Record<string, unknown> = {}): Base => ({
  manifest,
  targets,
  weekdays: [1, 2, 3, 4, 5],
  window_start: '08:00',
  window_end: '18:00',
  interval_min_seconds: 5,
  interval_max_seconds: 30,
  ...extra,
})

export const byIds = (ids: string[]) => ({ version: 1, mode: 'ids', filters: {}, ids })

export async function recipients(u: User, dispatchId: string, status = '') {
  const items: Any[] = []
  for (let page = 1; page < 50; page++) {
    const res = await u.c.get(`/api/mass-dispatches/${dispatchId}/recipients?limit=50&page=${page}${status ? `&status=${status}` : ''}`)
    if (res.status !== 200) throw new Error(`recipients → ${res.status} ${res.text}`)
    items.push(...res.body.items)
    if (!res.body.page?.has_more) break
  }
  return items
}

export async function quota(u: User) {
  const res = await u.c.get('/api/mass-dispatches/quota')
  if (res.status !== 200) throw new Error(`quota → ${res.status} ${res.text}`)
  return res.body.mass_dispatch_quota ?? res.body.quota
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))

/** Envio multipart (manifesto como arquivo .json; alvos e dias em campos de formulário). */
export async function postMultipart(env: Env, u: User, b: Base) {
  const form = new FormData()
  form.append('manifest', new Blob([JSON.stringify(b.manifest)], { type: 'application/json' }), 'manifest.json')
  b.targets.forEach((t, i) => {
    form.append(`targets[${i}][connection_id]`, t.connection_id)
    form.append(`targets[${i}][flow_id]`, t.flow_id)
  })
  for (const d of b.weekdays) form.append('weekdays[]', String(d))
  for (const k of ['window_start', 'window_end', 'interval_min_seconds', 'interval_max_seconds', 'name', 'daily_limit'] as const)
    if (b[k] !== undefined) form.append(k, String(b[k]))
  const res = await env.app.request('/api/mass-dispatches', {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm', 'x-forwarded-for': randomIp() },
    body: form,
  })
  const text = await res.text()
  let parsed: Any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body: parsed, text }
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

export interface Runner {
  deps: Any
  /** ticks agendados via deps.schedule */
  scheduled: Array<{ job: Any; delayMs: number }>
  setNow: (iso: string | number) => void
  advance: (ms: number) => void
  clock: () => number
}

/** Deps do runner com relógio controlado, RNG fixo (padrão 0) e schedule capturado. */
export function runner(env: Env, opts: { now?: string; rng?: () => number; step?: number; extra?: Record<string, unknown> } = {}): Runner {
  let t = Date.parse(opts.now ?? '2026-10-19T13:00:00Z') // segunda 10:00 em São Paulo
  const scheduled: Runner['scheduled'] = []
  const step = opts.step ?? 0
  const deps = {
    db: env.db,
    wa: env.wa,
    publisher: env.publisher,
    schedule: async (job: Any, delayMs: number) => void scheduled.push({ job, delayMs }),
    now: () => {
      const d = new Date(t)
      t += step
      return d
    },
    rng: opts.rng ?? (() => 0),
    retryDelayMs: 5_000,
    pausedRecheckMs: 7_000,
    ...opts.extra,
  }
  return {
    deps,
    scheduled,
    setNow: (iso) => void (t = typeof iso === 'number' ? iso : Date.parse(iso)),
    advance: (ms) => void (t += ms),
    clock: () => t,
  }
}

export const tick = (env: Env, r: Runner, dispatchId: string, targetId: string) => env.core.runMassDispatchTick(r.deps, { dispatchId, targetId })

export async function getDispatch(u: User, id: string) {
  const res = await u.c.get(`/api/mass-dispatches/${id}`)
  if (res.status !== 200) throw new Error(`GET dispatch → ${res.status} ${res.text}`)
  return res.body.mass_dispatch
}

/** Cria o disparo pela API (T60) e devolve o DTO. */
export async function createDispatch(u: User, b: Base) {
  const res = await u.c.post('/api/mass-dispatches', b)
  if (res.status !== 201) throw new Error(`POST /api/mass-dispatches → ${res.status} ${res.text}`)
  return res.body.mass_dispatch
}

/** Sobrescreve warmupStartedAt devolvido por wa.sessions.get (para variar a capacidade de warm-up). */
export function overrideWarmup(env: Env, sessionId: string, startedAt: string | null) {
  const w = env.wa as Any
  w.__warmup ??= new Map<string, string | null>()
  if (!w.__patched) {
    const orig = w.sessions.get.bind(w.sessions)
    w.sessions.get = async (id: string) => {
      const v = await orig(id)
      return w.__warmup.has(id) ? { ...v, warmupStartedAt: w.__warmup.get(id) } : v
    }
    w.__patched = true
  }
  w.__warmup.set(sessionId, startedAt)
}
