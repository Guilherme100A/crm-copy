// Ambiente da suíte T119 (rotas de mensagens/mídia da T49 + escopo de chat da T31/T48):
//  - createApp com FakeWaGateway, resolveSession, pttConverter e chatPublisher falsos (mesmo desenho da suíte T49)
//  - owner por register/login; membros por SQL (permission_keys explícitas); escopo pela rota da T31
//  - chats criados pela ingestão de mensagem recebida (ChatIngest da T33); department_id por SQL
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const rand = (n = 4) => randomBytes(n).toString('hex')

export interface Env {
  tmp: TempDatabase
  db: Any
  gateway: Any
  app: Any
  sessions: Map<string, string>
  connections: Map<string, { companyId: string; connectionId: string }>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t119-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const sessions = new Map<string, string>()
  const connections = new Map<string, { companyId: string; connectionId: string }>()
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      blobStore: new FsBlobStore(storageDir),
      waGateway: gateway,
      resolveSession: async (companyId: string, connectionId: string) => sessions.get(`${companyId}:${connectionId}`) ?? null,
      pttConverter: async (data: Uint8Array) => ({ audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...data.subarray(0, 16)]), mime: 'audio/ogg; codecs=opus', seconds: 3 }),
      chatPublisher: { publish: async () => {} },
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, gateway, app, sessions, connections, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface Actor {
  c: ApiClient
  userId: string
  companyId: string
  cookie: string
}

function clientOn(env: Env, cookie: string, companyId: string | null): ApiClient {
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
    companyId,
  })
  const [k, v] = cookie.split('=')
  c.cookies.set(k!, v!)
  return c
}

async function register(env: Env): Promise<{ userId: string; companyId: string; cookie: string }> {
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t119')
  const c = createClient({ fetcher: (path, init) => env.app.request(path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-forwarded-for': randomIp() } }) })
  const reg = await c.post('/api/auth/register', { name: `Pessoa ${uniqueId('t119')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  return { userId: login.body.user.id, companyId: login.body.companies[0].id, cookie: `crm_session=${c.cookies.get('crm_session')}` }
}

export interface Owner extends Actor {
  connectionId: string
  sessionId: string
}

/** Owner com empresa própria e uma conexão ligada a uma sessão STABLE do FakeWaGateway. */
export async function newOwner(env: Env): Promise<Owner> {
  const r = await register(env)
  const connectionId = randomUUID()
  const sessionId = env.gateway.addSession({ state: 'STABLE' }).id
  env.sessions.set(`${r.companyId}:${connectionId}`, sessionId)
  env.connections.set(sessionId, { companyId: r.companyId, connectionId })
  return { ...r, c: clientOn(env, r.cookie, r.companyId), connectionId, sessionId }
}

export interface Member extends Actor {
  memberId: string
}

export async function addMember(env: Env, owner: Owner, role: 'admin' | 'member', keys: string[] | null = ['chat.view']): Promise<Member> {
  const r = await register(env)
  const [m] = await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4) RETURNING id`, [
    owner.companyId,
    r.userId,
    role,
    keys,
  ])
  return { userId: r.userId, companyId: owner.companyId, cookie: r.cookie, c: clientOn(env, r.cookie, owner.companyId), memberId: m.id }
}

export async function department(owner: Owner, name = uniqueId('Depto')) {
  const res = await owner.c.post('/api/departments', { name })
  if (res.status !== 201) throw new Error(`departamento: ${res.status} ${res.text}`)
  return res.body.department.id as string
}

export async function setScope(owner: Owner, memberId: string, departmentIds: string[]) {
  const res = await owner.c.put(`/api/departments/members/${memberId}/scope`, { department_ids: departmentIds, connection_ids: [] })
  if (res.status !== 200) throw new Error(`escopo: ${res.status} ${res.text}`)
}

/** Chat criado pela ingestão de uma mensagem recebida, no departamento dado; inclui uma mensagem enviada (para apagar). */
export async function chatIn(env: Env, o: Owner, departmentId: string | null) {
  const core: Any = await import('@crm/core')
  const ingest = new core.ChatIngest({
    db: env.db,
    publisher: { publish: async () => {} },
    waGateway: env.gateway,
    resolveConnection: async (sid: string) => env.connections.get(sid) ?? null,
  })
  const e164 = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const waId = `WAIN-${rand(6)}`
  await ingest.handle({
    v: 1,
    type: 'message.inbound',
    session_id: o.sessionId,
    at: new Date().toISOString(),
    message: { id: waId, from: `${e164.slice(1)}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), type: 'conversation', text: 'olá', push_name: 'Cliente' },
  })
  const [contact] = await env.q(`SELECT id FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [o.companyId, e164])
  const [chat] = await env.q(`UPDATE crm.chats SET department_id = $3 WHERE company_id = $1 AND contact_id = $2 RETURNING *`, [o.companyId, contact.id, departmentId])
  const [inbound] = await env.q(`SELECT * FROM crm.messages WHERE company_id = $1 AND wa_message_id = $2`, [o.companyId, waId])
  const [outbound] = await env.q(
    `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, wa_message_id)
     VALUES ($1, $2, 'outbound', 'user', 'text', 'mensagem para apagar', 'sent', $3) RETURNING *`,
    [o.companyId, chat.id, `WAOUT-${rand(6)}`],
  )
  return { id: chat.id as string, inboundId: inbound.id as string, outboundId: outbound.id as string }
}

/** PNG pequeno com cabeçalho real. */
export function png(size = 2048): { blob: Blob; name: string } {
  const buf = Buffer.alloc(size, 0x20)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  return { blob: new Blob([buf], { type: 'image/png' }), name: `img-${rand()}.png` }
}

/** POST /api/media (multipart `file`) com o cookie e a empresa do ator. */
export async function upload(env: Env, a: Actor, file = png()) {
  const form = new FormData()
  form.append('file', file.blob, file.name)
  const res = await env.app.request('/api/media', {
    method: 'POST',
    headers: { cookie: a.cookie, 'x-requested-with': 'crm', 'x-company-id': a.companyId, 'x-forwarded-for': randomIp() },
    body: form,
  })
  const text = await res.text()
  if (res.status !== 201 && res.status !== 200) throw new Error(`upload: ${res.status} ${text}`)
  return JSON.parse(text).media.id as string
}

/** Estado observável de efeitos colaterais: mensagens do chat no banco, envios e leituras no gateway. */
export async function sideEffects(env: Env, chatId: string) {
  const [m] = await env.q(`SELECT count(*)::int AS n, count(deleted_at)::int AS deleted FROM crm.messages WHERE chat_id = $1`, [chatId])
  const [chat] = await env.q(`SELECT unread_count FROM crm.chats WHERE id = $1`, [chatId])
  return { messages: m.n as number, deleted: m.deleted as number, unread: chat.unread_count as number, sent: env.gateway.sent.length as number, reads: env.gateway.reads.length as number }
}
