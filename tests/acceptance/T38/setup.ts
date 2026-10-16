// Ambiente da suíte T38 (contrato combinado com o Torno):
//  - app de `@crm/api` com deps.logger = createLogger({ destination }) capturando todo o output do pino
//  - deps.aiKeyProbe espião/controlável (POST /api/ai-keys/:id/test)
//  - OPENROUTER_API_URL apontando para um servidor HTTP local fake (GET /models)
//  - CREDENTIALS_KEY fixa no processo: app e AiKeysService usam o mesmo cifrador
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface ProbeCall {
  provider: string
  secret: string
}

export interface FakeOpenRouter {
  url: string
  requests: Array<{ path: string; authorization: string | undefined }>
  /** resposta da próxima chamada: status + corpo */
  reply: { status: number; body: unknown }
  close: () => Promise<void>
}

export interface Env {
  tmp: TempDatabase
  db: Any
  core: Any
  app: Any
  logs: string[]
  probeCalls: ProbeCall[]
  /** se definido, o probe lança este erro (a mensagem pode conter a chave) */
  probeFailure: { fn: ((secret: string) => Error) | null }
  openrouter: FakeOpenRouter
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

async function startOpenRouter(): Promise<FakeOpenRouter> {
  const state: FakeOpenRouter = {
    url: '',
    requests: [],
    reply: { status: 200, body: { data: [] } },
    close: async () => {},
  }
  const server: Server = createServer((req, res) => {
    state.requests.push({ path: req.url ?? '', authorization: req.headers.authorization })
    res.writeHead(state.reply.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state.reply.body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  state.url = `http://127.0.0.1:${port}/api/v1`
  state.close = () => new Promise<void>((r) => server.close(() => r()))
  return state
}

export async function startEnv(): Promise<Env> {
  // chave de cifra fixa para app e serviço (definida antes de carregar os módulos)
  process.env.CREDENTIALS_KEY ||= randomBytes(32).toString('base64')
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  for (const n of ['AiKeysService', 'ProviderNotConfiguredError']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const openrouter = await startOpenRouter()
  process.env.OPENROUTER_API_URL = openrouter.url
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const logs: string[] = []
  const logger = createLogger({ level: 'trace', destination: { write: (s: string) => void logs.push(String(s)) } as Any })
  const probeCalls: ProbeCall[] = []
  const probeFailure: Env['probeFailure'] = { fn: null }
  const app = api.createApp({
    db,
    redis,
    logger,
    mailer: new MemoryMailer(),
    trustProxy: true,
    aiKeyProbe: async ({ provider, secret }: ProbeCall) => {
      probeCalls.push({ provider, secret })
      await new Promise((r) => setTimeout(r, 5))
      if (probeFailure.fn) throw probeFailure.fn(secret)
    },
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    app,
    logs,
    probeCalls,
    probeFailure,
    openrouter,
    q,
    close: async () => {
      await openrouter.close()
      await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
      await Promise.resolve(redis.quit()).catch(() => redis.disconnect())
      await db.$client.end().catch(() => {})
      await tmp.drop()
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface Owner {
  c: ApiClient
  userId: string
  companyId: string
}

export async function newOwner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t38')
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t38')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  return { c, userId: login.body.user.id, companyId }
}

/** Segredo único e reconhecível. */
export const newSecret = (prefix = 'sk-test') => `${prefix}-SEGREDO-${randomBytes(12).toString('hex')}`

export async function createKey(o: Owner, provider: string, secret = newSecret(), name = uniqueId('Chave')) {
  const res = await o.c.post('/api/ai-keys', { provider, name, secret })
  if (res.status !== 201) throw new Error(`criar chave: ${res.status} ${res.text}`)
  return { key: res.body.key, secret, res }
}

export const fieldPaths = (res: { body: Any }) =>
  (res.body?.error?.details?.fields ?? []).map((f: Any) => (Array.isArray(f.path) ? f.path.join('.') : String(f.path)))
