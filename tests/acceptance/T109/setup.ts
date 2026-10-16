// Ambiente da suíte T109. Contrato combinado com o Operário (Bigorna), tudo de '@crm/core':
// FakeXPag({ clientId, clientSecret }) → start() / url / stop() / requests / cashins / webhookFor(txId, opts) / failNext(status, body);
// createXPagGateway({ clientId, clientSecret, webhookSecret, webhookUrl?, apiUrl }), PaymentGatewayError (code).
// createApp deps: paymentsEnv { XPAG_API_URL: fake.url }, logger (pino com destino capturado para conferir os logs).
// Nunca a API real da XPag: só o FakeXPag local.
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const CLIENT_ID = 'cli-t109'
export const CLIENT_SECRET = `sk_xpag_${randomBytes(12).toString('hex')}`

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  core: Any
  fake: Any
  /** linhas de log emitidas pelo logger da API */
  logs: string[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['FakeXPag', 'createXPagGateway', 'PaymentGatewayError']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const fake = new core.FakeXPag({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  await fake.start()
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
    await fake.stop().catch(() => {})
  }
  try {
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      logger,
      // segredos cifrados em repouso (regra 1.4 nº 8): cifrador com chave própria da suíte, sem depender de CREDENTIALS_KEY no env
      credentialsCipher: createCipher({ key: generateCredentialsKey() }),
      paymentsEnv: { XPAG_API_URL: fake.url, API_PUBLIC_URL: 'http://api.t109.test' },
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, core, fake, logs, q, close }
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
  const email = fakeEmail('t109')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t109')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id }
}

export async function newMember(env: Env, companyId: string, keys: string[] | null): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Cria a integração XPag pela API; devolve o DTO. */
export async function newIntegration(u: User, extra: Record<string, unknown> = {}) {
  const res = await u.c.post('/api/payment-integrations', { label: `XPag ${uniqueId('x')}`, gateway: 'xpag', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...extra })
  if (res.status !== 201) throw new Error(`POST /api/payment-integrations → ${res.status} ${res.text}`)
  return res.body.integration
}

/** Fluxo com bloco Pagamento apontando para a integração; `status` gravado direto (o AC trata do fluxo ativo). */
export async function flowUsing(env: Env, u: User, integrationId: string, status: 'active' | 'draft' | 'paused' = 'active') {
  const f = await u.c.post('/api/flows', { name: `Cobrança ${uniqueId('f')}` })
  if (f.status !== 201) throw new Error(`POST /api/flows → ${f.status} ${f.text}`)
  const id = f.body.flow.id
  const def = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
      {
        id: 'P',
        type: 'payment',
        name: 'Cobrar',
        position: { x: 200, y: 0 },
        actions: [{ id: 'P-a', type: 'create_payment_charge', order: 0, config: { gateway: 'xpag', payment_integration_id: integrationId, currency: 'BRL', method: 'PIX', amount: 50 } }],
      },
    ],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'P' }],
    variables: [],
    refs: {},
  }
  const put = await u.c.put(`/api/flows/${id}/definition`, def)
  if (put.status !== 200) throw new Error(`PUT definition → ${put.status} ${put.text}`)
  await env.q(`UPDATE crm.flows SET status = $2 WHERE id = $1`, [id, status])
  return { id: id as string, name: f.body.flow.name as string }
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
