// Ambiente da suíte T49 (contrato combinado com o Fole):
// - createApp(deps) + app.request; deps.waGateway = FakeWaGateway; deps.resolveSession(companyId, connectionId) → sessionId;
//   deps.pttConverter injetado; deps.mediaLimits pequenos; deps.chatPublisher fake; FsBlobStore temporário.
// - Chats e mensagens recebidas criados pela porta ChatIngest da T33 com o mesmo mapeamento sessão ↔ conexão.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const rand = (n = 4) => randomBytes(n).toString('hex')
export const LIMITS = { image: 64 * 1024, video: 64 * 1024, audio: 32 * 1024, document: 96 * 1024 }
export const OGG = 'audio/ogg; codecs=opus'

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  gateway: Any
  app: Any
  published: Array<{ companyId: string; type: string; data: Any }>
  converted: Array<{ size: number; mime: string }>
  /** companyId:connectionId → sessionId do gateway */
  sessions: Map<string, string>
  /** sessionId → { companyId, connectionId } */
  connections: Map<string, { companyId: string; connectionId: string }>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  if (typeof api.createApp !== 'function') throw new Error('@crm/api não exporta createApp')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t49-blobs-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const published: Env['published'] = []
  const converted: Env['converted'] = []
  const sessions = new Map<string, string>()
  const connections = new Map<string, { companyId: string; connectionId: string }>()
  const close = async () => {
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
      pttConverter: async (data: Uint8Array, mime: string) => {
        converted.push({ size: data.length, mime })
        return { audio: new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...data.subarray(0, 16)]), mime: OGG, seconds: 3 }
      },
      mediaLimits: LIMITS,
      chatPublisher: {
        async publish(companyId: string, type: string, data: Any) {
          published.push({ companyId, type, data })
        },
      },
      appName: 'ProdutoTesteT49',
      webPublicUrl: 'http://web.t49.test',
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, gateway, app, published, converted, sessions, connections, q, close }
  } catch (err) {
    await close().catch(() => {})
    throw err
  }
}

export const fakeIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export function client(env: Env, ip = fakeIp()) {
  return createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
}

export interface Owner {
  c: ReturnType<typeof client>
  userId: string
  companyId: string
  connectionId: string
  sessionId: string
}

/** Owner com empresa própria e uma conexão ligada a uma sessão STABLE do FakeWaGateway. */
export async function owner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t49')
  const c = client(env)
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t49')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const [row] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const companyId = login.body?.companies?.[0]?.id
  if (!companyId) throw new Error(`login sem companies[0].id: ${login.text}`)
  c.setCompany(companyId)
  const connectionId = randomUUID()
  const sessionId = env.gateway.addSession({ state: 'STABLE' }).id
  env.sessions.set(`${companyId}:${connectionId}`, sessionId)
  env.connections.set(sessionId, { companyId, connectionId })
  return { c, userId: row.id, companyId, connectionId, sessionId }
}

/** Chat criado pela ingestão de uma mensagem recebida (porta ChatIngest da T33). */
export async function inboundChat(env: Env, o: Owner, text = 'oi, preciso de ajuda') {
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
    message: { id: waId, from: `${e164.slice(1)}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), type: 'conversation', text, push_name: 'Cliente' },
  })
  const [contact] = await env.q(`SELECT id FROM crm.contacts WHERE company_id = $1 AND phone_e164 = $2`, [o.companyId, e164])
  if (!contact) throw new Error('ingest não criou o contato')
  const [chat] = await env.q(`SELECT * FROM crm.chats WHERE company_id = $1 AND contact_id = $2`, [o.companyId, contact.id])
  const [msg] = await env.q(`SELECT * FROM crm.messages WHERE company_id = $1 AND wa_message_id = $2`, [o.companyId, waId])
  return { chat, msg, phone: e164, waId, contactId: contact.id as string }
}

/** Arquivo com magic bytes reais do formato, completado até `size`. */
export function fakeFile(kind: 'png' | 'jpeg' | 'mp4' | 'ogg' | 'mpeg' | 'pdf' | 'exe', size = 2048): { blob: Blob; mime: string; name: string } {
  const spec: Record<string, { magic: number[]; mime: string; ext: string }> = {
    png: { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png', ext: 'png' },
    jpeg: { magic: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], mime: 'image/jpeg', ext: 'jpg' },
    mp4: { magic: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32], mime: 'video/mp4', ext: 'mp4' },
    ogg: { magic: [0x4f, 0x67, 0x67, 0x53], mime: 'audio/ogg', ext: 'ogg' },
    mpeg: { magic: [0x49, 0x44, 0x33, 0x03], mime: 'audio/mpeg', ext: 'mp3' },
    pdf: { magic: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], mime: 'application/pdf', ext: 'pdf' },
    exe: { magic: [0x4d, 0x5a, 0x90, 0x00], mime: 'application/x-msdownload', ext: 'exe' },
  }
  const s = spec[kind]!
  const buf = Buffer.alloc(size, 0x20)
  Buffer.from(s.magic).copy(buf)
  return { blob: new Blob([buf], { type: s.mime }), mime: s.mime, name: `arquivo-${rand()}.${s.ext}` }
}

/** POST /api/media (multipart, campo `file`) com o cookie e a empresa do cliente. */
export async function upload(env: Env, o: Owner, file: { blob: Blob; name: string }) {
  const form = new FormData()
  form.append('file', file.blob, file.name)
  const cookie = [...o.c.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await env.app.request('/api/media', {
    method: 'POST',
    headers: { cookie, 'x-requested-with': 'crm', 'x-company-id': o.companyId, 'x-forwarded-for': fakeIp() },
    body: form,
  })
  const text = await res.text()
  let body: Any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* não JSON */
  }
  return { status: res.status, body, text }
}

/** GET binário com o cookie e a empresa do cliente. */
export async function download(env: Env, o: Owner, path: string) {
  const cookie = [...o.c.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const res = await env.app.request(path, { method: 'GET', headers: { cookie, 'x-company-id': o.companyId, 'x-forwarded-for': fakeIp() } })
  return { status: res.status, mime: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) }
}
