// Ambiente da suíte T73 (fontes de venda por webhook genérico). Contrato combinado com o Operário (Cinzel):
// - CRUD /api/sale-sources (settings.integrations.*): { name, active?, hmac_secret?, mapping, status_map?, amount_unit? }
//   → DTO { id, name, active, token, public_url, hmac_configured, mapping, status_map, amount_unit, ... } (sem hmac_secret).
// - Público POST /api/hooks/sales/:token → 202 { ok, event_id, status: 'pending' }; 404 token/inativa; 401 HMAC
//   (x-signature = hex HMAC-SHA256 do corpo cru, com ou sem 'sha256='); createApp({ inboundSalesEnqueue(data, { jobId }) }).
// - new InboundSalesProcessor({ db, publisher }).process({ eventId, saleSourceId, companyId }) (@crm/core).
// - GET /api/sale-sources/:id/events, POST .../events/:eventId/replay, POST /api/sale-sources/:id/test, POST .../rotate-token.
// - GET /api/contacts/:id/attribution → { attribution: { first_touch, last_touch } | null }.
import { createHmac, randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const RATE_LIMIT_SMALL = 3

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  /** mesmo banco, rate limit reduzido (RATE_LIMIT_SMALL por minuto) */
  appRl: Any
  processor: Any
  /** jobs capturados da recepção pública: { data, opts } */
  jobs: Array<{ data: Any; opts: Any }>
  /** eventos publicados pelo processador (espião) */
  published: Any[]
  logs: string[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (core.InboundSalesProcessor === undefined) throw new Error('@crm/core não exporta InboundSalesProcessor')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const logs: string[] = []
  const logger = createLogger({ level: 'debug', destination: { write: (s: string) => void logs.push(s) } as Any })
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const jobs: Env['jobs'] = []
    const published: Any[] = []
    const base = {
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      logger,
      trustProxy: true,
      // segredo HMAC cifrado em repouso com chave própria da suíte (sem depender de CREDENTIALS_KEY no env)
      credentialsCipher: createCipher({ key: generateCredentialsKey() }),
      inboundSalesEnqueue: async (data: Any, opts: Any) => void jobs.push({ data, opts }),
    }
    const app = api.createApp(base)
    const appRl = api.createApp({ ...base, inboundSalesRateLimit: { limit: RATE_LIMIT_SMALL, windowMs: 60_000 } })
    const publisher = { publish: async (...args: Any[]) => void published.push(args) }
    const processor = new core.InboundSalesProcessor({ db, publisher })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, appRl, processor, jobs, published, logs, q, close }
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
}

export async function newOwner(env: Env): Promise<User> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t73')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t73')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id }
}

/** Mapeamento padrão da suíte (checkout fictício). */
export const MAPPING = {
  external_id: '$.pedido.id',
  status: '$.pedido.situacao',
  amount: '$.pedido.valor',
  currency: '$.pedido.moeda',
  phone: '$.cliente.telefone',
  name: '$.cliente.nome',
  email: '$.cliente.email',
  utm_source: '$.rastreio.utm_source',
  utm_medium: '$.rastreio.utm_medium',
  utm_campaign: '$.rastreio.utm_campaign',
  ctwa_clid: '$.rastreio.ctwa_clid',
  source_id: '$.rastreio.ad_id',
}

export interface OrderInput {
  id?: string
  situacao?: string
  valor?: string | number
  telefone?: string | null
  nome?: string
  utm?: Record<string, string>
}

let seq = 0
/** Celular BR local (DDD 11) único: 11 9XXXX-XXXX. */
export const localPhone = () => `119${String(Date.now() % 1e6).padStart(6, '0')}${String(++seq % 100).padStart(2, '0')}`

export function order(o: OrderInput = {}): Any {
  const cliente: Any = { nome: o.nome ?? 'Maria Compradora', email: `compra.${randomBytes(3).toString('hex')}@exemplo.test` }
  if (o.telefone !== null) cliente.telefone = o.telefone ?? localPhone()
  return {
    pedido: { id: o.id ?? `PED-${uniqueId('p')}`, situacao: o.situacao ?? 'paid', valor: o.valor ?? '149.90', moeda: 'BRL' },
    cliente,
    ...(o.utm ? { rastreio: o.utm } : {}),
  }
}

export async function newSource(u: User, body: Record<string, unknown> = {}): Promise<Any> {
  const res = await u.c.post('/api/sale-sources', { name: `Checkout ${uniqueId('s')}`, mapping: MAPPING, ...body })
  if (res.status !== 201) throw new Error(`POST /api/sale-sources → ${res.status} ${res.text}`)
  return res.body.sale_source
}

export const sign = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest('hex')

/** POST público em /api/hooks/sales/:token (corpo cru). */
export async function postSale(app: Any, token: string, payload: unknown, headers: Record<string, string> = {}) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const res: Response = await app.request(`/api/hooks/sales/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp(), ...headers },
    body: raw,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não-JSON */
  }
  return { status: res.status, body, text }
}

/** Processa (como o worker) os jobs capturados; devolve os ids processados. */
export async function processAll(env: Env): Promise<string[]> {
  const ids: string[] = []
  while (env.jobs.length) {
    const j = env.jobs.shift()!
    await env.processor.process(j.data)
    ids.push(j.data.eventId)
  }
  return ids
}

/** Recebe (202) e processa; devolve a linha do evento. */
export async function deliver(env: Env, token: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await postSale(env.app, token, payload, headers)
  if (res.status !== 202) throw new Error(`POST /api/hooks/sales → ${res.status} ${res.text}`)
  await processAll(env)
  return eventRow(env, res.body.event_id)
}

export async function eventRow(env: Env, id: string) {
  const [r] = await env.q(`SELECT * FROM crm.inbound_sale_events WHERE id = $1`, [id])
  return r
}

export async function counts(env: Env, companyId: string) {
  const [r] = await env.q(
    `SELECT (SELECT count(*) FROM crm.inbound_sale_events e JOIN crm.sale_sources s ON s.id = e.sale_source_id WHERE s.company_id = $1)::int AS events,
            (SELECT count(*) FROM crm.contacts WHERE company_id = $1)::int AS contacts,
            (SELECT count(*) FROM crm.sales WHERE company_id = $1)::int AS sales`,
    [companyId],
  )
  return r as { events: number; contacts: number; sales: number }
}

export async function salesByExternal(env: Env, companyId: string, externalId: string) {
  return env.q(`SELECT * FROM crm.sales WHERE company_id = $1 AND external_id = $2`, [companyId, externalId])
}

export async function contactByPhone(env: Env, companyId: string, local: string) {
  const [c] = await env.q(`SELECT * FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [companyId, `+55${local}`])
  return c
}
