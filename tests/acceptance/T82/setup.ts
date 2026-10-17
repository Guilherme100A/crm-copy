// Ambiente da suíte T82 (Vitest): banco descartável migrado, Redis real (db 1), app `@crm/api` sem porta (app.request),
// FakeWaGateway injetado (para provar que o simulador não envia nada) e um servidor HTTP local que conta as chamadas
// (alvo do nó Integração: o simulador nunca pode chamá-lo). Contrato em spec/reports/T82-entrega.md.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  app: Any
  gateway: FakeWaGateway
  /** URL do servidor local "de terceiros" e o número de requisições que ele recebeu. */
  hookUrl: string
  hits: () => number
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp: TempDatabase = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  let hitCount = 0
  const server: Server = createServer((_req, res) => {
    hitCount++
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const gateway = new FakeWaGateway()
  const close = async () => {
    await new Promise((r) => server.close(r))
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: gateway, trustProxy: true })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { app, gateway, hookUrl: `http://127.0.0.1:${port}/hook`, hits: () => hitCount, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env, ip = fakeIp()): ApiClient {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface User {
  userId: string
  companyId: string
  c: ApiClient
}

/** Cadastro + login: owner da empresa criada no cadastro (ativa no cliente). */
export async function newOwner(env: Env): Promise<User> {
  const email = fakeEmail('t82')
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const reg = await client(env).post('/api/auth/register', { name: `Pessoa ${uniqueId('t82')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { userId: u.id, companyId: m.company_id, c }
}

/** Usuário novo como membro da empresa, com lista explícita de permissões. */
export async function newMember(env: Env, companyId: string, keys: string[]): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

// ---------- definições (crm.flow/v1) ----------

type Action = { type: string; config: Record<string, unknown> }
export const node = (id: string, type: string, actions: Action[] = [], i = 0) => ({
  id,
  type,
  name: `Bloco ${id}`,
  position: { x: 220 * i, y: 0 },
  actions: actions.map((a, k) => ({ id: `${id}-a${k}`, order: k, ...a })),
})
export const msg = (id: string, text: string) => node(id, 'message', [{ type: 'send_message', config: { message_text: text } }])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/:/g, '_'), from, handle, to })
export const def = (nodes: Any[], edges: Any[], entry = 'start') => ({ schema: 'crm.flow/v1', entry, nodes, edges, variables: [], refs: {} })

export async function createFlow(u: User): Promise<string> {
  const res = await u.c.post('/api/flows', { name: uniqueId('Simular') })
  if (res.status !== 201) throw new Error(`POST /api/flows → ${res.status} ${res.text}`)
  return res.body.flow.id
}

/** Grava o rascunho montado a partir do nó de início do bundle (id e config dados pelo servidor). */
export async function putDraft(u: User, flowId: string, build: (start: Any) => Any): Promise<string> {
  const b = await u.c.get(`/api/flows/${flowId}/editor-bundle`)
  if (b.status !== 200) throw new Error(`editor-bundle → ${b.status} ${b.text}`)
  const startId: string = b.body.definition.entry ?? b.body.definition.nodes.find((n: Any) => n.type === 'start').id
  const start = b.body.definition.nodes.find((n: Any) => n.id === startId)
  const res = await u.c.put(`/api/flows/${flowId}/definition`, build(start))
  if (res.status !== 200) throw new Error(`PUT definition → ${res.status} ${res.text}`)
  return startId
}

/** Cria o fluxo e grava o rascunho. */
export async function draft(u: User, build: (start: Any) => Any): Promise<{ flowId: string; startId: string }> {
  const flowId = await createFlow(u)
  return { flowId, startId: await putDraft(u, flowId, build) }
}


export const simulate = (u: User, flowId: string, body: unknown = {}) => u.c.post(`/api/flows/${flowId}/simulate`, body)

export const texts = (sim: { messages: Array<{ kind: string; text?: string }> }) => sim.messages.map((m) => (m.kind === 'text' ? m.text : `[${m.kind}]`))
