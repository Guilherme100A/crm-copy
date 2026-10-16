// Ambiente da suíte T61 (contrato combinado com o Cinzel):
// - API: createApp (app.request) com FakeWaGateway; configs por PUT/POST /api/connection-flow-configs*,
//   horário por PUT /api/business-hours/:connectionId (T31); conexão real por POST /api/connections (T40).
// - Porta: new FlowTriggers({ db, engine: { startRun }, waGateway, now }).handleInbound(CrmInboundEvent) de '@crm/core';
//   `startRun` é espião (registra o fluxo iniciado); o desfecho vem no retorno { outcome, flow_id, out_of_hours }.
// - Contatos, chats, mensagens, fluxos e runs semeados por SQL nas tabelas crm.* (dados de fixture).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { fakeEmail, uniqueId } from '../helpers/factories'
import { createClient } from '../helpers/http'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64')

export const HOUR = 3_600_000

export interface Env {
  tmp: TempDatabase
  db: Any
  gateway: Any
  app: Any
  core: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  if (typeof core.FlowTriggers !== 'function') throw new Error('@crm/core não exporta FlowTriggers')
  const tmp = await createTempDatabase({ migrate: true })
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t61-'))
  const db = createDb(tmp.url)
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const gateway = new FakeWaGateway()
  const app = api.createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    blobStore: new FsBlobStore(storageDir),
    waGateway: gateway,
    appName: 'ProdutoTesteT61',
    webPublicUrl: 'http://web.t61.test',
    trustProxy: true,
  })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    gateway,
    app,
    core,
    q,
    close: async () => {
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      await tmp.drop()
      rmSync(storageDir, { recursive: true, force: true })
    },
  }
}

export interface Tenant {
  c: ReturnType<typeof createClient>
  userId: string
  companyId: string
  connectionId: string
  sessionId: string
}

/** Dono com empresa própria e uma conexão real (sessão no FakeWaGateway). */
export async function tenant(env: Env): Promise<Tenant> {
  const c = createClient({ fetcher: (path, init) => env.app.request(path, init) })
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const email = fakeEmail('t61')
  const reg = await c.post('/api/auth/register', { name: `Dona ${uniqueId('t61')}`, email, password, password_confirmation: password })
  if (reg.status >= 300) throw new Error(`cadastro: ${reg.status} ${reg.text}`)
  const login = await c.post('/api/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login: ${login.status} ${login.text}`)
  const companyId = login.body.companies[0].id
  c.setCompany(companyId)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const conn = await c.post('/api/connections', { name: 'Conexão T61' })
  if (conn.status !== 201) throw new Error(`conexão: ${conn.status} ${conn.text}`)
  return { c, userId: u.id, companyId, connectionId: conn.body.connection.id, sessionId: conn.body.connection.session_id }
}

export async function newFlow(env: Env, companyId: string, name = uniqueId('Fluxo')): Promise<string> {
  const [f] = await env.q(`INSERT INTO crm.flows (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, name])
  return f.id
}

const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`

export interface Chat {
  chatId: string
  contactId: string
  phone: string
}

export async function newChat(env: Env, t: Tenant, s: { status?: string; assignedUserId?: string | null; aiAgentId?: string | null } = {}): Promise<Chat> {
  const p = phone()
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [t.companyId, uniqueId('Contato'), p])
  const [ch] = await env.q(
    `INSERT INTO crm.chats (company_id, connection_id, contact_id, status, assigned_user_id, ai_agent_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [t.companyId, t.connectionId, ct.id, s.status ?? 'waiting', s.assignedUserId ?? null, s.aiAgentId ?? null],
  )
  return { chatId: ch.id, contactId: ct.id, phone: p }
}

/** Grava uma mensagem do contato no chat (como a ingestão da T33) e devolve o CrmInboundEvent correspondente. */
export async function inbound(env: Env, t: Tenant, chat: Chat, text: string, at: Date, flags: { created?: boolean; reopened?: boolean } = {}) {
  const wa = `WA-${randomBytes(6).toString('hex')}`
  const [m] = await env.q(
    `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, status, body, wa_message_id, created_at)
     VALUES ($1, $2, 'inbound', 'contact', 'text', 'received', $3, $4, $5) RETURNING id`,
    [t.companyId, chat.chatId, text, wa, at.toISOString()],
  )
  return {
    company_id: t.companyId,
    connection_id: t.connectionId,
    session_id: t.sessionId,
    chat_id: chat.chatId,
    contact_id: chat.contactId,
    message_id: m.id,
    wa_message_id: wa,
    type: 'text',
    text,
    from_me: false,
    chat_created: flags.created ?? false,
    chat_reopened: flags.reopened ?? false,
  }
}

/** FlowTriggers com startRun espião e relógio controlável. */
export function triggers(env: Env, clock: { now: Date }) {
  const started: Array<Record<string, unknown>> = []
  // porta do motor (T25): startRun(ctx, { flowId, contactId, chatId, trigger }) → { runId, expectedSeq }
  // Como o motor real, cria o run em crm.flow_runs (flow_trigger_events.run_id tem FK para ele).
  const startRun = async (ctx: { companyId: string }, input: Record<string, unknown>) => {
    started.push({ ...input, companyId: ctx?.companyId })
    const [run] = await env.q(
      `INSERT INTO crm.flow_runs (company_id, flow_id, contact_id, chat_id, status, trigger) VALUES ($1, $2, $3, $4, 'running', $5) RETURNING id`,
      [ctx.companyId, input.flowId, input.contactId, input.chatId ?? null, JSON.stringify(input.trigger ?? null)],
    )
    return { runId: run.id as string, expectedSeq: 1 }
  }
  // controle real dos runs (T30), com agendador de timers falso: a palavra-chave cancela o run atual por ele
  const timers = { schedule: async () => {}, cancel: async () => {} }
  const control = new env.core.FlowControl({ db: env.db, timers, now: () => clock.now })
  const ft = new env.core.FlowTriggers({ db: env.db, engine: { startRun }, control, waGateway: env.gateway, now: () => clock.now })
  /** Fluxos iniciados (flow_id ou flowId do pedido ao motor). */
  const flows = () => started.map((s) => (s.flowId ?? s.flow_id ?? (s as Any).flow?.id) as string)
  return { ft, started, flows, handle: (ev: unknown) => ft.handleInbound(ev) }
}

export async function putConfig(t: Tenant, body: Record<string, unknown>) {
  const r = await t.c.put(`/api/connection-flow-configs/${t.connectionId}`, body)
  if (r.status !== 200) throw new Error(`PUT config: ${r.status} ${r.text}`)
  return r.body
}

export async function activeAgent(env: Env, companyId: string): Promise<string> {
  const [a] = await env.q(`INSERT INTO crm.ai_agents (company_id, name, status) VALUES ($1, 'Agente T61', 'active') RETURNING id`, [companyId])
  return a.id
}
