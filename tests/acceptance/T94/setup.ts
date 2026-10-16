// Ambiente da suíte T94 (servidor MCP com token estático). Contrato combinado com o Operário (Cinzel):
// - GET/POST /api/mcp_credentials, DELETE /api/mcp_credentials/:id (sessão + X-Requested-With); POST devolve
//   { mcp_credential, token, mcp_endpoint_url } (token crm_mcp_ + 43 base64url, só nessa resposta).
// - POST /api/mcp: Streamable HTTP sem sessão, JSON; Authorization: Bearer <token>; 401 { error: UNAUTHORIZED } +
//   WWW-Authenticate: Bearer realm="mcp" para token ausente/malformado/desconhecido/expirado/revogado.
// - 5 ferramentas só de leitura (list_contacts, get_contact, list_connections, list_flows, list_chats), resultado em
//   content[0].text (JSON), sempre filtradas pela empresa do token.
// Massa pela API (contatos, fluxos) e por SQL só onde não há rota de criação (conexão, chat).
import { randomBytes } from 'node:crypto'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ensureConnection } from '../helpers/connections'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient, type ApiClient } from '../helpers/http'
import { McpClient } from './mcp'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MCP_PATH = '/api/mcp'
export const TOKEN_RE = /^crm_mcp_[A-Za-z0-9_-]{43}$/

export interface Env {
  tmp: TempDatabase
  db: Any
  app: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
  }
  try {
    const app = api.createApp({ db, redis, mailer: new MemoryMailer(), waGateway: new FakeWaGateway(), trustProxy: true })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, app, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface User {
  c: ApiClient
  userId: string
  companyId: string
}

export async function newOwner(env: Env): Promise<User> {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t94')
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t94')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { c, userId: u.id, companyId: m.company_id }
}

/** Membro da empresa com as permissões dadas. */
export async function newMember(env: Env, companyId: string, keys: string[]): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, 'member', $3)`, [companyId, u.userId, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

/** Cria uma credencial pela API; devolve { credential, token, endpoint }. */
export async function newCredential(u: User, body: Record<string, unknown> = {}) {
  const res = await u.c.post('/api/mcp_credentials', { mcp_credential: { name: `Cursor ${uniqueId('m')}`, auth_type: 'static', ...body } })
  if (res.status !== 201) throw new Error(`POST /api/mcp_credentials → ${res.status} ${res.text}`)
  return { credential: res.body.mcp_credential, token: res.body.token as string, endpoint: res.body.mcp_endpoint_url as string, body: res.body }
}

/** Cliente MCP (sem sessão do CRM: só o Bearer). */
export const mcp = (env: Env, token: string | null) => new McpClient((path, init) => env.app.request(path, init), MCP_PATH, token)

/** POST cru no endpoint MCP com headers livres (para os casos de 401). */
export async function rawMcp(env: Env, headers: Record<string, string>) {
  const res: Response = await env.app.request(MCP_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'radar-t94', version: '1.0.0' } } }),
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não-JSON */
  }
  return { status: res.status, headers: res.headers, body, text }
}

let phoneSeq = 0
export const phone = () => `+55119${String(Date.now() % 1e6).padStart(6, '0')}${String(++phoneSeq % 100).padStart(2, '0')}`

/** Massa de uma empresa: contato, conexão, fluxo e chat, todos marcados com `tag`. */
export async function seedCompany(env: Env, u: User, tag: string) {
  const ct = await u.c.post('/api/contacts', { name: `Contato ${tag}`, phone: phone(), email: `${tag.toLowerCase()}@exemplo.test` })
  if (ct.status !== 201) throw new Error(`contato: ${ct.status} ${ct.text}`)
  const contactId = (ct.body.contact ?? ct.body).id as string
  const connectionId = await ensureConnection(env.q, u.companyId, { name: `Conexão ${tag}` })
  const fl = await u.c.post('/api/flows', { name: `Fluxo ${tag}` })
  if (fl.status !== 201) throw new Error(`fluxo: ${fl.status} ${fl.text}`)
  const flowId = (fl.body.flow ?? fl.body).id as string
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [u.companyId, connectionId, contactId])
  return { contactId, connectionId, flowId, chatId: ch.id as string }
}
