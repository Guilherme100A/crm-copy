// Ambiente da suíte T68 (contrato combinado com o Torno):
//  - AiAgentRuntime de `@crm/core` com FakeLlm/FakeStt/FakeTts (`@crm/ai/testing`), FakeWaGateway (`@crm/wa-port/testing`),
//    MediaService (T49), publisher e flows espiões, guard opcional (UsageGuard da T24)
//  - runtime.onInbound(CrmInboundEvent), runtime.flush(chatId), runtime.idle(), opção onTurn(info)
//  - agente criado pela API da T39 (POST /api/ai-agents + publish); chat/contato/mensagens por SQL
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { ensureConnection } from '../helpers/connections'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MODEL = { provider: 'openai', model: 'gpt-teste-t68' }

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  core: Any
  ai: Any
  gateway: Any
  media: Any
  app: Any
  sessions: Map<string, string>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const ai: Any = await import('@crm/ai/testing')
  for (const n of ['AiAgentRuntime', 'MediaService']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  const storage = mkdtempSync(join(tmpdir(), 'crm-t68-'))
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const sessions = new Map<string, string>()
  const media = new core.MediaService({ blobStore: new FsBlobStore(storage) })
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storage),
    waGateway: gateway,
    resolveSession: async (companyId: string, connectionId: string) => sessions.get(`${companyId}:${connectionId}`) ?? null,
    chatPublisher: { publish: async () => {} },
    aiProviderKeys: { isConfigured: () => true },
    trustProxy: true,
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    redis,
    core,
    ai,
    gateway,
    media,
    app,
    sessions,
    q,
    close: async () => {
      await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
      await Promise.resolve(redis.quit()).catch(() => redis.disconnect())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storage, { recursive: true, force: true })
    },
  }
}

const randomIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0]! % 250)}`

export interface Owner {
  c: ApiClient
  userId: string
  companyId: string
  connectionId: string
  sessionId: string
}

export async function newOwner(env: Env): Promise<Owner> {
  const password = `Senha-${randomBytes(6).toString('hex')}`
  const email = fakeEmail('t68')
  const ip = randomIp()
  const c = createClient({
    fetcher: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('x-forwarded-for', ip)
      return env.app.request(path, { ...init, headers })
    },
  })
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t68')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login falhou: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const sessionId = env.gateway.addSession({ state: 'STABLE' }).id
  // conexão real em crm.connections (FK de chats.connection_id desde a T40), ligada à sessão do FakeWaGateway
  const connectionId = await ensureConnection(env.q, companyId, { id: randomUUID(), sessionId })
  env.sessions.set(`${companyId}:${connectionId}`, sessionId)
  return { c, userId: login.body.user.id, companyId, connectionId, sessionId }
}

/** Agente publicado pela API da T39. */
export async function newAgent(o: Owner, opts: { settings?: Record<string, unknown>; skills?: Any[] } = {}) {
  const res = await o.c.post('/api/ai-agents', {
    name: uniqueId('Agente'),
    generated_prompt: 'Você é um atendente cordial de uma escola de cursos.',
    model: MODEL,
    settings: { buffer_seconds: 5, split_messages: false, ...opts.settings },
    skills: opts.skills ?? [],
  })
  if (res.status !== 201) throw new Error(`agente: ${res.status} ${res.text}`)
  const pub = await o.c.post(`/api/ai-agents/${res.body.agent.id}/publish`, {})
  if (pub.status !== 200) throw new Error(`publish: ${pub.status} ${pub.text}`)
  return res.body.agent.id as string
}

export const skill = (action_type: string, action_params: Record<string, unknown> = {}) => ({
  enabled: true,
  when_text: 'quando o cliente pedir para falar com uma pessoa',
  action_type,
  action_params,
  schedule_mode: 'now',
  silence_amount: 1,
  silence_unit: 'days',
})

export interface Chat {
  id: string
  contactId: string
  phone: string
}

/** Contato + chat atendido pelo agente. */
export async function newChat(env: Env, o: Owner, agentId: string): Promise<Chat> {
  const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [contact] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Cliente T68', $2) RETURNING id`, [o.companyId, phone])
  const [chat] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id, status, ai_agent_id) VALUES ($1, $2, $3, 'waiting', $4) RETURNING id`, [
    o.companyId,
    o.connectionId,
    contact.id,
    agentId,
  ])
  return { id: chat.id, contactId: contact.id, phone }
}

/** Grava a mensagem recebida (como o ingest da T33) e devolve o CrmInboundEvent correspondente. */
export async function inbound(env: Env, o: Owner, chat: Chat, text: string, extra: { type?: string; media?: Any; waId?: string } = {}) {
  const waId = extra.waId ?? `WAIN-${randomBytes(5).toString('hex')}`
  const type = extra.type ?? 'text'
  const [msg] = await env.q(
    `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, media, status, wa_message_id, wa_timestamp)
     VALUES ($1, $2, 'inbound', 'contact', $3, $4, $5, 'received', $6, now()) RETURNING id`,
    [o.companyId, chat.id, type, type === 'text' ? text : null, extra.media ? JSON.stringify(extra.media) : null, waId],
  )
  await env.q(`UPDATE crm.chats SET last_message_at = now(), last_inbound_at = now() WHERE id = $1`, [chat.id])
  return {
    company_id: o.companyId,
    connection_id: o.connectionId,
    session_id: o.sessionId,
    chat_id: chat.id,
    contact_id: chat.contactId,
    message_id: msg.id,
    wa_message_id: waId,
    type,
    text: type === 'text' ? text : null,
    from_me: false,
    chat_created: false,
    chat_reopened: false,
  }
}

export interface Rig {
  runtime: Any
  llm: Any
  stt: Any
  tts: Any
  published: Array<{ companyId: string; type: string; data: Any }>
  flowRuns: Any[]
  turns: Any[]
}

/** Runtime novo com FakeLlm roteirizado e espiões. */
export function rig(env: Env, script: Any[], opts: { stt?: Any; tts?: boolean; guard?: Any } = {}): Rig {
  const llm = new env.ai.FakeLlm({ script })
  const stt = opts.stt ?? new env.ai.FakeStt({ text: 'transcrição padrão' })
  const tts = new env.ai.FakeTts()
  const published: Rig['published'] = []
  const flowRuns: Any[] = []
  const turns: Any[] = []
  const runtime = new env.core.AiAgentRuntime({
    db: env.db,
    llm,
    waGateway: env.gateway,
    resolveSession: async (companyId: string, connectionId: string) => env.sessions.get(`${companyId}:${connectionId}`) ?? null,
    media: env.media,
    stt,
    ...(opts.tts === false ? {} : { tts }),
    publisher: { publish: async (companyId: string, type: string, data: Any) => void published.push({ companyId, type, data }) },
    flows: { startRun: async (ctx: Any, args: Any) => void flowRuns.push({ ctx, args }) },
    ...(opts.guard ? { guard: opts.guard } : {}),
    onTurn: (info: Any) => void turns.push(info),
  })
  return { runtime, llm, stt, tts, published, flowRuns, turns }
}

/** Texto de todas as partes de uma mensagem do LlmRequest. */
export const textOf = (m: Any): string =>
  typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: Any) => p?.text ?? '').join('\n')

export const lastUserText = (req: Any) => textOf([...(req?.messages ?? [])].reverse().find((m: Any) => m.role === 'user'))

export const sentTo = (env: Env, phone: string) => env.gateway.sent.filter((s: Any) => s.phone === phone || s.phone === phone.replace(/^\+/, ''))

export async function state(env: Env, chatId: string) {
  const [row] = await env.q(`SELECT * FROM crm.ai_conversation_state WHERE chat_id = $1`, [chatId])
  return row
}

export async function chatRow(env: Env, chatId: string) {
  const [row] = await env.q(`SELECT * FROM crm.chats WHERE id = $1`, [chatId])
  return row
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
