/* eslint-disable @typescript-eslint/no-explicit-any -- respostas JSON da API e estado do FakeTransport lidos como dados */
// Montado como produção (AC-T120-01..05): wa-worker REAL (WA_TRANSPORT=fake) + API (createApp com o WaGateway RPC)
// + worker do CRM por `startProductionWorker` (a mesma função do main.ts), WA_GATEWAY=rpc, mesmo Postgres, Redis e
// STORAGE_DIR. LLM: FakeLlm atrás do resolvedor BYOK da empresa (AI_MODE=fake); nenhuma chave real.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from '@crm/ai'
import { createApp } from '@crm/api'
import { FsExportFileStore, registerExportKind } from '@crm/core'
import { aiUsage, aiWallets, contacts, flowRuns, llmPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, FsBlobStore, generateCredentialsKey, initCredentialsCrypto, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createWaGatewayFromEnv, type WaGatewayFromEnv } from '@crm/wa-gateway-rpc'
import { startWaWorker, type WaWorkerHandle } from '@crm/wa-worker'
import { and, count, eq, sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { onCrmInbound } from '../consumers/chats'
import { startProductionWorker, type ProductionWorker } from './production-worker'

const id = randomBytes(4).toString('hex')
const TOKEN = `t120-${id}`
const STREAM = `test:t120:wsm:events:${id}`
const KEY = generateCredentialsKey()
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

let tmp: TempDatabase
let storage: string
let redis: Redis
let waWorker: WaWorkerHandle
let crmWorker: ProductionWorker
let apiWa: WaGatewayFromEnv
let app: ReturnType<typeof createApp>
let db: Database
let offExportKind = () => undefined as void

beforeAll(async () => {
  // Banco Redis próprio: as filas BullMQ do CRM têm nomes e prefixo fixos (`crm:flow-step`…); no db 1 compartilhado, os
  // workers dos testes de outros worktrees consomem estes jobs. Produtores e consumidores leem REDIS_URL na chamada.
  process.env.REDIS_URL = `redis://127.0.0.1:6379/${2 + (randomBytes(1)[0]! % 14)}`
  tmp = await createTempDatabase({ migrate: true })
  storage = mkdtempSync(join(tmpdir(), 'crm-t120-'))
  redis = redisConnection()
  initCredentialsCrypto({ key: KEY })
  const base = { DATABASE_URL: tmp.url, REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379/1', CREDENTIALS_KEY: KEY, INTERNAL_TOKEN: TOKEN, STORAGE_DIR: storage, LOG_LEVEL: 'silent' }
  waWorker = await startWaWorker({
    env: { ...base, WA_TRANSPORT: 'fake', WA_RPC_PORT: '0', WA_RPC_HOST: '127.0.0.1', WA_QUEUE_PREFIX: `wsm_t120_${id}`, WA_EVENTS_STREAM: STREAM, ANTIBAN_MODE: 'passthrough' },
    healthIntervalMs: 0,
  })
  const env = { ...base, WA_GATEWAY: 'rpc', WA_RPC_URL: waWorker.url, WA_RPC_PROFILE: 'crm', WA_EVENTS_STREAM: STREAM, AI_MODE: 'fake' }
  crmWorker = await startProductionWorker({ env, migrate: false, handleSignals: false, logger: createLogger({ level: process.env.T120_DEBUG ? 'warn' : 'silent' }) })
  db = crmWorker.db
  apiWa = createWaGatewayFromEnv(env, { redis })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer(),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    waGateway: apiWa.gateway,
    blobStore: new FsBlobStore({ dir: storage }),
    exportFiles: new FsExportFileStore({ dir: join(storage, 'exports') }),
    aiKeyProbe: async () => undefined,
  })
  // AC-04: export com kind registrado no próprio teste (contacts_export é da T66), no mesmo processo do worker.
  offExportKind = registerExportKind(`t120_names_${id}`, {
    permission: 'contacts.view',
    columns: [{ key: 'name', header: 'Nome' }],
    query: async function* (ctx) {
      yield* await ctx.db.select({ name: contacts.name }).from(contacts).where(eq(contacts.companyId, ctx.companyId))
    },
  })
}, 180_000)

afterAll(async () => {
  offExportKind()
  await crmWorker?.stop()
  await apiWa?.close()
  await waWorker?.stop()
  const keys = await redis.keys(`wsm_t120_${id}:*`)
  if (keys.length) await redis.del(...keys)
  await redis.del(STREAM)
  await redis.quit()
  await tmp?.drop()
  rmSync(storage, { recursive: true, force: true })
}, 60_000)

// ------------------------------------------------------------------ utilitários

interface Session {
  cookie: string
  companyId: string
}
function expectStatus(r: { status: number; body: any }, status: number) {
  if (r.status !== status) throw new Error(`HTTP ${r.status} (esperado ${status}): ${JSON.stringify(r.body)}`)
}
const rnd = () => randomBytes(3).toString('hex')
async function signUp(): Promise<Session> {
  const email = `t120-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.120.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'T', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as any
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  return { cookie: /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0], companyId: user.last_company_id }
}
async function call(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method, headers: { ...H, cookie: s.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const textBody = await res.text()
  return { status: res.status, body: textBody ? (JSON.parse(textBody) as any) : {} }
}
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) {
      if (process.env.T120_DEBUG) {
        const { appendFileSync } = await import('node:fs')
        const dump = { what, events: await db.execute(sql`select * from crm.flow_trigger_events`), runs: await db.execute(sql`select id, status, error, trigger, flow_id from crm.flow_runs`), jobs: await db.execute(sql`select id, kind, status, error from crm.background_jobs`), queues: Object.fromEntries(await Promise.all([...crmWorker.app.queues].map(async ([n, q]) => [n, { counts: await q.getJobCounts(), failed: (await q.getFailed()).map((j) => j.failedReason), waiting: (await q.getWaiting()).map((j) => j.id), prefix: (q as any).opts?.prefix }]))) }
        appendFileSync(process.env.T120_DEBUG, JSON.stringify(dump, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2))
      }
      throw new Error(`timeout: ${what}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}
const fakeState = async (sessionId: string) =>
  (await (await fetch(`${waWorker.url}/internal/fake/sessions/${sessionId}/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any
const sentTexts = async (sessionId: string) => ((await fakeState(sessionId)).sent as any[]).map((m) => m.content?.text).filter(Boolean) as string[]

const node = (nid: string, type: string, actions: unknown[] = []) => ({ id: nid, type, name: nid, position: { x: 0, y: 0 }, actions })
/** Fluxo ativo start → message(send_message `texto`). */
async function messageFlow(s: Session, name: string, message: string): Promise<string> {
  const flow = (await call(s, 'POST', '/api/flows', { name })).body.flow
  const def = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [node('start', 'start'), node('m', 'message', [{ id: 'a1', type: 'send_message', order: 0, config: { message_text: message } }])],
    edges: [{ id: 'e1', from: 'start', handle: 'source', to: 'm' }],
    variables: [],
    refs: {},
  }
  expectStatus(await call(s, 'PUT', `/api/flows/${flow.id}/definition`, def), 200)
  expectStatus(await call(s, 'POST', `/api/flows/${flow.id}/activate`), 200)
  return flow.id
}

/** Conexão pela API (sessão no wa-worker), conectada pelo FakeTransport. */
async function connectedConnection(s: Session): Promise<{ id: string; sessionId: string }> {
  const created = await call(s, 'POST', '/api/connections', { name: `Conexão ${rnd()}` })
  expect(created.status).toBe(201)
  const { id: connectionId, session_id: sessionId } = created.body.connection
  expectStatus(await call(s, 'POST', `/api/connections/${connectionId}/connect`), 200)
  await until('transporte', async () => (waWorker.fake!.last(sessionId) ? true : undefined))
  waWorker.fake!.open(sessionId)
  await until('sessão conectada', async () => ['WARMING', 'STABLE'].includes((await apiWa.gateway.sessions.get(sessionId)).status) || undefined)
  return { id: connectionId, sessionId }
}

const jid = () => `55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}@s.whatsapp.net`
const receive = (sessionId: string, from: string, body: string) => waWorker.fake!.require(sessionId).receive({ from, text: body })
/** Resolve quando a mensagem `body` de `from` terminou de passar pelos ouvintes do `crm.inbound` (fluxos, agente). */
function inboundHandled(from: string, body: string, ms = 60_000): Promise<void> {
  const phone = `+${from.split('@')[0]}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (off(), reject(new Error(`timeout: crm.inbound de ${body}`))), ms)
    const off = onCrmInbound(async (e) => {
      if (e.text !== body) return
      const [c] = await db.select({ phone: contacts.phoneE164 }).from(contacts).where(eq(contacts.id, e.contact_id))
      if (c?.phone !== phone) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

async function chatOf(s: Session, from: string): Promise<any> {
  const phone = `+${from.split('@')[0]}`
  return until(`chat de ${phone}`, async () => ((await call(s, 'GET', '/api/chats')).body.items as any[]).find((c) => c.contact?.phone_e164 === phone || c.contact?.phone === phone))
}
const history = async (s: Session, chatId: string) => (await call(s, 'GET', `/api/chats/${chatId}/messages`)).body.items as any[]

/** SSE da empresa: acumula os `event:` recebidos. */
async function sse(s: Session): Promise<{ events: string[]; close(): void }> {
  const ctrl = new AbortController()
  const res = await app.request(`/api/events?company_id=${s.companyId}`, { headers: { cookie: s.cookie }, signal: ctrl.signal })
  expect(res.status).toBe(200)
  const events: string[] = []
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.startsWith('event:')) events.push(line.slice(6).trim())
      }
    } catch {
      // abortado
    }
  })()
  return { events, close: () => ctrl.abort() }
}

// ------------------------------------------------------------------ critérios

describe('T120 montado como produção', () => {
  let s: Session
  let conn: { id: string; sessionId: string }

  beforeAll(async () => {
    s = await signUp()
    conn = await connectedConnection(s)
  }, 60_000)

  it('AC-T120-01/05: palavra-chave dispara o fluxo; o nó envia 1 vez e aparece no chat como flow; flow_run.updated pelo SSE', async () => {
    const flowId = await messageFlow(s, 'Menu', 'Olá do fluxo')
    expectStatus(await call(s, 'PUT', `/api/connection-flow-configs/${conn.id}`, { keyword_triggers: [{ flow_id: flowId, conditions: [{ keyword: 'menu', match_type: 'equals' }] }] }), 200)
    const stream = await sse(s)
    try {
      const from = jid()
      receive(conn.sessionId, from, 'Menu')
      const chat = await chatOf(s, from)
      const flowMsg = await until('mensagem do fluxo no chat', async () => (await history(s, chat.id)).find((m) => m.sender_type === 'flow'))
      expect(flowMsg).toMatchObject({ direction: 'outbound', type: 'text', body: 'Olá do fluxo', media: { actor: expect.stringMatching(/^flow:/) } })
      await until('enviado pelo wa-worker', async () => (await sentTexts(conn.sessionId)).includes('Olá do fluxo') || undefined)
      await new Promise((r) => setTimeout(r, 500))
      expect((await sentTexts(conn.sessionId)).filter((t) => t === 'Olá do fluxo')).toHaveLength(1)
      expect((await history(s, chat.id)).filter((m) => m.sender_type === 'flow')).toHaveLength(1)
      await until('flow_run.updated no SSE', async () => stream.events.includes('flow_run.updated') || undefined)
      const [run] = await db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId))
      expect(run).toMatchObject({ status: 'completed', trigger: expect.objectContaining({ type: 'keyword' }) })
    } finally {
      stream.close()
    }
  }, 180_000)

  it('AC-T120-05: resolver o chat dispara o fluxo de atendimento finalizado da conexão', async () => {
    const thanks = await messageFlow(s, 'Obrigado', 'Obrigado pelo contato')
    expectStatus(await call(s, 'PUT', `/api/connection-flow-configs/${conn.id}`, { finished_attendance_flow_id: thanks }), 200)
    const from = jid()
    receive(conn.sessionId, from, 'quero falar com alguém')
    const chat = await chatOf(s, from)
    expectStatus(await call(s, 'POST', `/api/chats/${chat.id}/resolve`), 200)
    const msg = await until('mensagem de atendimento finalizado', async () => (await history(s, chat.id)).find((m) => m.body === 'Obrigado pelo contato'))
    expect(msg.sender_type).toBe('flow')
    const [run] = await db.select().from(flowRuns).where(eq(flowRuns.flowId, thanks))
    expect(run?.trigger).toEqual({ type: 'finished_attendance' })
  }, 180_000)

  it('AC-T120-02: fora do horário a mensagem automática é enviada e fica no histórico como system', async () => {
    // Ativo e sem intervalos = sempre fechado.
    const put = await call(s, 'PUT', `/api/business-hours/${conn.id}`, { active: true, action_type: 'message', message_text: 'Estamos fora do horário', business_hours: [] })
    expect(put.status).toBe(200)
    const from = jid()
    receive(conn.sessionId, from, 'boa noite')
    const chat = await chatOf(s, from)
    const msg = await until('mensagem fora do horário no chat', async () => (await history(s, chat.id)).find((m) => m.sender_type === 'system'))
    expect(msg).toMatchObject({ direction: 'outbound', body: 'Estamos fora do horário', media: { actor: 'crm:system:business-hours' } })
    await until('enviada pelo wa-worker', async () => (await sentTexts(conn.sessionId)).includes('Estamos fora do horário') || undefined)
    await call(s, 'PUT', `/api/business-hours/${conn.id}`, { active: false })
  }, 180_000)

  it('AC-T120-03: agente de IA com chave BYOK responde (FakeLlm pelo resolvedor) e grava ai_usage; carteira esgotada → sem chamada ao LLM', async () => {
    const fake = crmWorker.production.fakeLlm!
    expectStatus(await call(s, 'POST', '/api/ai-keys', { provider: 'openai', name: 'Chave OpenAI', secret: 'sk-t120-fake' }), 201)
    const agent = (
      await call(s, 'POST', '/api/ai-agents', {
        name: 'Ana IA',
        generated_prompt: 'Você atende clientes.',
        model: { provider: 'openai', model: 'gpt-4o-mini' },
        settings: { buffer_enabled: false },
      })
    ).body.agent
    expectStatus(await call(s, 'POST', `/api/ai-agents/${agent.id}/publish`), 200)
    // Preço vigente do modelo (o UsageGuard da T24 recusa modelo sem preço).
    await db.insert(llmPrices).values({ provider: 'openai', model: 'gpt-4o-mini', effectiveFrom: new Date('2020-01-01T00:00:00Z'), inputPerMtokMicros: 150_000, outputPerMtokMicros: 600_000 }).onConflictDoNothing()
    await db.insert(aiWallets).values({ companyId: s.companyId, balanceCredits: 1_000_000, status: 'ok' }).onConflictDoUpdate({ target: aiWallets.companyId, set: { balanceCredits: 1_000_000, status: 'ok' } })

    const from = jid()
    // T126: o chat aparece na API (commit do ingest) antes de os ouvintes do `crm.inbound` do "oi" rodarem; ligar o
    // agente nessa janela faz ele responder ao "oi" também. Espera o "oi" passar por todos os ouvintes (este é
    // inscrito depois do consumidor do agente e eles rodam em ordem) antes do PATCH.
    const oiDone = inboundHandled(from, 'oi')
    receive(conn.sessionId, from, 'oi')
    const chat = await chatOf(s, from)
    await oiDone
    expectStatus(await call(s, 'PATCH', `/api/chats/${chat.id}`, { ai_agent_id: agent.id }), 200)
    fake.enqueue(text('Olá, sou a Ana!'))
    const before = fake.callCount
    receive(conn.sessionId, from, 'quero saber o preço')
    const reply = await until('resposta da IA', async () => (await history(s, chat.id)).find((m) => m.sender_type === 'ai'), 60_000)
    expect(reply.body).toContain('Olá, sou a Ana!')
    expect(fake.callCount).toBe(before + 1)
    const usage = async () => Number((await db.select({ n: count() }).from(aiUsage).where(eq(aiUsage.companyId, s.companyId)))[0]!.n)
    expect(await until('ai_usage', async () => (await usage()) || undefined)).toBe(1)

    // Carteira esgotada: o UsageGuard recusa antes do provedor.
    await db.update(aiWallets).set({ balanceCredits: 0, maxOverrunCredits: 0, status: 'exhausted' }).where(eq(aiWallets.companyId, s.companyId))
    fake.enqueue(text('não deveria'))
    receive(conn.sessionId, from, 'e o prazo?')
    await until('mensagem recebida', async () => (await history(s, chat.id)).some((m) => m.body === 'e o prazo?') || undefined)
    await new Promise((r) => setTimeout(r, 3000))
    expect(fake.callCount).toBe(before + 1)
    expect(await usage()).toBe(1)
    expect((await history(s, chat.id)).filter((m) => m.sender_type === 'ai')).toHaveLength(1)
  }, 180_000)

  it('AC-T120-04: importação CSV e exportação rodam no worker montado, terminam completed e o arquivo fica no STORAGE_DIR compartilhado', async () => {
    const form = new FormData()
    form.append('file', new File(['nome,telefone\nMaria T120,+5511977771111\nJoão T120,+5511977772222\n'], 'contatos.csv', { type: 'text/csv' }))
    const imp = await app.request('/api/contacts/imports', { method: 'POST', headers: { cookie: s.cookie, 'x-requested-with': 'crm' }, body: form })
    expect(imp.status).toBe(201)
    const importJob = ((await imp.json()) as any).job
    const doneImport = await until('import completed', async () => {
      const j = (await call(s, 'GET', `/api/jobs/${importJob.id}`)).body.job
      return j?.status === 'completed' ? j : j?.status === 'failed' ? Promise.reject(new Error(JSON.stringify(j))) : undefined
    })
    expect(doneImport.status).toBe('completed')
    const names = (await db.select({ name: contacts.name }).from(contacts).where(and(eq(contacts.companyId, s.companyId)))).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['Maria T120', 'João T120']))

    const exp = await call(s, 'POST', '/api/jobs', { kind: `t120_names_${id}` })
    expect(exp.status).toBe(201)
    const doneExport = await until('export completed', async () => {
      const j = (await call(s, 'GET', `/api/jobs/${exp.body.job.id}`)).body.job
      return j?.status === 'completed' ? j : j?.status === 'failed' ? Promise.reject(new Error(JSON.stringify(j))) : undefined
    })
    expect(doneExport.status).toBe('completed')
    const dir = join(storage, 'exports')
    expect(existsSync(dir) && readdirSync(dir, { recursive: true }).length).toBeTruthy()
    const file = await app.request(`/api/jobs/${exp.body.job.id}/file`, { headers: { cookie: s.cookie } })
    expect(file.status).toBe(200)
    expect(await file.text()).toContain('Maria T120')
  }, 180_000)

  it('AC-T122-02: disparo em massa criado pela API é preparado, envia pelo wa-worker e termina completed', async () => {
    const flowId = await messageFlow(s, `Disparo ${rnd()}`, `Oferta T122 ${id}`)
    const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
    const contact = await call(s, 'POST', '/api/contacts', { name: 'Cliente T122', phone })
    expectStatus(contact, 201)
    const created = await call(s, 'POST', '/api/mass-dispatches', {
      targets: [{ connection_id: conn.id, flow_id: flowId }],
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      window_start: '00:00',
      window_end: '23:59',
      interval_min_seconds: 0,
      interval_max_seconds: 0,
      manifest: { version: 1, mode: 'ids', ids: [contact.body.contact.id] },
    })
    expectStatus(created, 201)
    const dispatchId = created.body.mass_dispatch.id
    const done = await until(
      'disparo completed',
      async () => {
        const d = (await call(s, 'GET', `/api/mass-dispatches/${dispatchId}`)).body.mass_dispatch
        return d?.status === 'completed' ? d : d?.status === 'failed' ? Promise.reject(new Error(JSON.stringify(d))) : undefined
      },
      90_000,
    )
    expect(done).toMatchObject({ sent_count: 1, pending_count: 0 })
    await until('mensagem do disparo no wa-worker', async () => (await sentTexts(conn.sessionId)).includes(`Oferta T122 ${id}`) || undefined)
  }, 180_000)

  it('AC-T123-01/02: distribuidor, etiqueta, status e venda aprovada publicam pelo SSE da empresa', async () => {
    // Empresa e conexão próprias: o antiban do wa-worker limita 5 envios/min por sessão e os casos anteriores deixam
    // estado na empresa compartilhada (agente de IA, gatilhos).
    const t = await signUp()
    const own = await connectedConnection(t)
    const [product] = (
      await db.execute(
        sql`insert into crm.products (company_id, name, currency, price_min_cents, price_max_cents, price_fallback_cents) values (${t.companyId}, 'Curso T123', 'BRL', 100, 100000, 4700) returning public_id`,
      )
    ).rows as Array<{ public_id: string }>
    const flow = (await call(t, 'POST', '/api/flows', { name: `CRM ${rnd()}` })).body.flow
    const a = (aid: string, type: string, config: unknown) => ({ id: aid, type, order: 0, config })
    const def = {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [
        node('start', 'start'),
        node('D', 'distributor', [a('d1', 'distribute_contacts', { outputs: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }] })]),
        node('T', 'tags', [a('t1', 'add_tags', { tags: ['Lead T123'] })]),
        node('C', 'chat_controller', [a('c1', 'change_chat_status', { chat_status: 'Atendimento' })]),
        node('V', 'approved_sale', [a('v1', 'register_approved_sale', { product_public_id: product!.public_id, amount_template: '97,00', push_title_template: 'Venda {produto.nome}', push_body_template: '{{customer.name}} comprou' })]),
        node('M', 'message', [a('m1', 'send_message', { message_text: `fim T123 ${id}` })]),
      ],
      edges: [
        { id: 'e1', from: 'start', handle: 'source', to: 'D' },
        { id: 'e2', from: 'D', handle: 'output:a', to: 'T' },
        { id: 'e3', from: 'D', handle: 'output:b', to: 'T' },
        { id: 'e4', from: 'T', handle: 'source', to: 'C' },
        { id: 'e5', from: 'C', handle: 'source', to: 'V' },
        { id: 'e6', from: 'V', handle: 'source', to: 'M' },
      ],
      variables: [],
      refs: {},
    }
    expectStatus(await call(t, 'PUT', `/api/flows/${flow.id}/definition`, def), 200)
    expectStatus(await call(t, 'POST', `/api/flows/${flow.id}/activate`), 200)
    expectStatus(await call(t, 'PUT', `/api/connection-flow-configs/${own.id}`, { keyword_triggers: [{ flow_id: flow.id, conditions: [{ keyword: 'crm123', match_type: 'equals' }] }] }), 200)
    const stream = await sse(t)
    try {
      receive(own.sessionId, jid(), 'crm123')
      for (const type of ['flow.distributor_updated', 'contact.updated', 'chat.updated', 'notification.created'])
        await until(`${type} no SSE`, async () => stream.events.includes(type) || undefined)
      // O passo publica os eventos antes do commit: espera o run terminar (o nó de mensagem M vem depois da venda).
      const run = await until('run terminado', async () => {
        const [r] = await db.select().from(flowRuns).where(eq(flowRuns.flowId, flow.id))
        return r && r.status !== 'running' ? r : undefined
      })
      expect(run.status, `${run.error}`).toBe('completed')
      await until('mensagem do fluxo enviada', async () => (await sentTexts(own.sessionId)).includes(`fim T123 ${id}`) || undefined)
    } finally {
      stream.close()
    }
  }, 180_000)
})
