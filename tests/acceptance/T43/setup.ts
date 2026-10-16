// Ambiente da suíte T43: banco descartável migrado, Redis real (db 1), app `@crm/api` sem porta.
// Contrato combinado com o Operário (Bigorna): deps opcionais do createApp `flowEngine`, `flowControl`,
// `flowStepEnqueue(job)`, `connectionName(ctx, connectionId) → string | null`, `blobStore`; permissão `flows.run`;
// rotas /api/flows/:id/{trigger,runs,share-code,export,paste-nodes}, /api/flow-runs/:id(/cancel), /api/chats/:id/flow-runs,
// /api/connections/:id/cancel-all-flow-runs, /api/flows/import, /api/flows/import-json; eventos flow_run.*.
// Pausa/retomada (T30 pela API): POST /pause → FlowControl.pauseFlow; POST /activate → resumeFlow após publicar.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, MemoryMailer, redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createClient, type ApiClient } from '../helpers/http'
import { fakeEmail, fakePhone, uniqueId, uuid } from '../helpers/factories'
import { connectSse, type SseConnection } from '../helpers/sse'
import { ensureConnection } from '../helpers/connections'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MIN = 60_000

export interface Env {
  tmp: TempDatabase
  db: Any
  redis: Any
  app: Any
  core: Any
  /** jobs `flow-step` que a API enfileirou */
  jobs: Array<{ runId: string; expectedSeq: number }>
  /** agendador falso de timers (registra schedule/cancel) */
  timers: { scheduled: Array<{ data: Any; delayMs: number }>; cancelled: Any[]; scheduler: Any }
  control: Any
  engine: Any
  /** `${companyId}:${connectionId}` → nome da conexão */
  connections: Map<string, string>
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const api: Any = await import('@crm/api')
  const core: Any = await import('@crm/core')
  const tmp = await createTempDatabase({ migrate: true })
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  const redis = redisConnection()
  redis.on?.('error', () => {})
  const storageDir = mkdtempSync(join(tmpdir(), 'crm-t43-'))
  const close = async () => {
    await Promise.resolve(api.stopRealtimeHub?.(redis)).catch(() => {})
    await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
    await db.$client.end().catch(() => {})
    await tmp.drop()
    rmSync(storageDir, { recursive: true, force: true })
  }
  try {
    const jobs: Env['jobs'] = []
    const scheduled: Env['timers']['scheduled'] = []
    const cancelled: Any[] = []
    const scheduler = {
      schedule: async (data: Any, delayMs: number) => void scheduled.push({ data, delayMs }),
      cancel: async (data: Any) => void cancelled.push(data),
    }
    const control = new core.FlowControl({ db, timers: scheduler, shortDelayMs: 0, enqueueStep: async () => {} })
    // Handlers de teste: `wait_response` espera resposta com prazo de 60 min; os demais seguem `source`.
    const registry = core.createNodeRegistry()
    registry.register('wait_response', { execute: async () => ({ wait: core.waitForReply({ delayMs: 60 * MIN }) }) })
    for (const t of ['message', 'tags', 'connection_flow']) registry.register(t, { execute: async () => ({ next: 'source' }) })
    const engine = new core.FlowEngine({ db, wa: new FakeWaGateway(), registry, hooks: control.engineHooks() })
    const connections = new Map<string, string>()
    const app = api.createApp({
      db,
      redis,
      mailer: new MemoryMailer(),
      waGateway: new FakeWaGateway(),
      blobStore: new FsBlobStore({ dir: storageDir }),
      mediaSigningKey: randomBytes(32),
      flowEngine: engine,
      flowControl: control,
      flowStepEnqueue: async (j: Any) => void jobs.push(j),
      connectionName: async (ctx: Any, connectionId: string) => connections.get(`${ctx.companyId}:${connectionId}`) ?? null,
      trustProxy: true,
    })
    const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
    return { tmp, db, redis, app, core, jobs, timers: { scheduled, cancelled, scheduler }, control, engine, connections, q, close }
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
  email: string
  companyId: string
  c: ApiClient
  token: string
}

/** Cadastro + login (T15); o usuário é owner da empresa criada no cadastro, que fica ativa no cliente. */
export async function newOwner(env: Env): Promise<User> {
  const email = fakeEmail('t43')
  const password = `Senha-${randomBytes(5).toString('hex')}`
  const reg = await client(env).post('/api/auth/register', { name: `Pessoa ${uniqueId('t43')}`, email, password, password_confirmation: password })
  if (reg.status < 200 || reg.status >= 300) throw new Error(`cadastro falhou: ${reg.status} ${reg.text}`)
  const c = client(env)
  const res = await c.post('/api/auth/login', { email, password })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${res.text}`)
  const [u] = await env.q(`SELECT id FROM crm.users WHERE lower(email) = lower($1)`, [email])
  const [m] = await env.q(`SELECT company_id FROM crm.company_members WHERE user_id = $1 AND role = 'owner' LIMIT 1`, [u.id])
  c.setCompany(m.company_id)
  return { userId: u.id, email, companyId: m.company_id, c, token: c.cookies.get('crm_session')! }
}

/** Usuário novo como membro da empresa, com lista explícita de permissões. */
export async function newMember(env: Env, companyId: string, keys: string[] | null, role: 'member' | 'admin' = 'member'): Promise<User> {
  const u = await newOwner(env)
  await env.q(`INSERT INTO crm.company_members (company_id, user_id, role, permission_keys) VALUES ($1, $2, $3, $4)`, [companyId, u.userId, role, keys])
  u.c.setCompany(companyId)
  return { ...u, companyId }
}

export interface Chat {
  chatId: string
  contactId: string
  connectionId: string
}

/** Contato + chat semeados direto no banco (crm.chats com connection_id solto até a T40). */
export async function newChat(env: Env, companyId: string, connectionId: string = uuid()): Promise<Chat> {
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Contato ${uniqueId('c')}`, fakePhone()])
  await ensureConnection(env.q, companyId, { id: connectionId })
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [companyId, connectionId, ct.id])
  return { chatId: ch.id, contactId: ct.id, connectionId }
}

/** Registra o nome de uma conexão na fonte injetada (`deps.connectionName`). */
export function newConnection(env: Env, companyId: string, name = `Conexão ${uniqueId('cx')}`): { id: string; name: string } {
  const id = uuid()
  env.connections.set(`${companyId}:${id}`, name)
  return { id, name }
}

export async function openEvents(env: Env, u: { token: string }, companyId: string): Promise<SseConnection> {
  const conn = await connectSse((path, init) => env.app.request(path, init), `/api/events?company_id=${companyId}`, { cookie: `crm_session=${u.token}` })
  if (conn.status !== 200) throw new Error(`GET /api/events → ${conn.status}: ${conn.text?.slice(0, 300)}`)
  await conn.waitFor((m) => m.event === 'ping', 10_000)
  return conn
}

export async function runRow(env: Env, runId: string) {
  const [r] = await env.q(`SELECT id, status, seq, wait, current_node_key, chat_id, contact_id, flow_id FROM crm.flow_runs WHERE id = $1`, [runId])
  return r
}

// ---------- definições (FlowDefinition crm.flow/v1, T10) ----------

export const msgNode = (id: string, x: number, y: number, text = `Mensagem ${id}`) => ({
  id,
  type: 'message',
  name: `Nó ${id}`,
  position: { x, y },
  actions: [{ id: `${id}-a1`, type: 'send_message', order: 0, config: { message_text: text } }],
})

export const waitNode = (id: string, x: number, y: number) => ({
  id,
  type: 'wait_response',
  name: `Espera ${id}`,
  position: { x, y },
  actions: [{ id: `${id}-a1`, type: 'wait_for_response', order: 0, config: { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' } }],
})

export const tagsNode = (id: string, x: number, y: number, tags: string[]) => ({
  id,
  type: 'tags',
  name: `Etiquetas ${id}`,
  position: { x, y },
  actions: [{ id: `${id}-a1`, type: 'add_tags', order: 0, config: { action: 'add', tags } }],
})

export const mediaNode = (id: string, x: number, y: number, mediaUrl: string) => ({
  id,
  type: 'message',
  name: `Mídia ${id}`,
  position: { x, y },
  actions: [{ id: `${id}-a1`, type: 'send_multi_media', order: 0, config: { media_type: 'image', media_source: 'file', media_url: mediaUrl, messages: [{ caption: 'catálogo' }] } }],
})

export const flowLinkNode = (id: string, x: number, y: number, targetFlowId: string) => ({
  id,
  type: 'connection_flow',
  name: `Conexão de fluxo ${id}`,
  position: { x, y },
  actions: [{ id: `${id}-a1`, type: 'execute_flow', order: 0, config: { target_flow_id: targetFlowId, target_flow_name: 'Outro fluxo' } }],
})

export const startNode = () => ({ id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] })

export const edge = (from: string, handle: string, to: string, id = `e-${from}-${handle}-${to}`) => ({ id, from, handle, to })

export const def = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [startNode(), ...nodes], edges, variables: [], refs: {} })

/** start → m1 → m2 (válida). */
export const msgDef = () => def([msgNode('m1', 200, 40), msgNode('m2', 400, 80)], [edge('start', 'source', 'm1'), edge('m1', 'source', 'm2')])

/** start → W (espera resposta, prazo 1 h) ─source→ R / ─timeout→ T. */
export const waitDef = () =>
  def([waitNode('W', 200, 0), msgNode('R', 400, -80), msgNode('T', 400, 80)], [edge('start', 'source', 'W'), edge('W', 'source', 'R'), edge('W', 'timeout', 'T')])

export async function createFlow(u: User, name = uniqueId('Fluxo')): Promise<Any> {
  const res = await u.c.post('/api/flows', { name })
  if (res.status !== 201) throw new Error(`POST /api/flows → ${res.status} ${res.text}`)
  return res.body.flow
}

export async function putDefinition(u: User, flowId: string, d: Any) {
  const res = await u.c.put(`/api/flows/${flowId}/definition`, d)
  if (res.status !== 200) throw new Error(`PUT definition → ${res.status} ${res.text}`)
  return res.body.definition
}

/** Fluxo com a definição dada; `activate` publica e ativa. */
export async function flowWith(u: User, d: Any, activate = true, name?: string): Promise<Any> {
  const flow = await createFlow(u, name)
  await putDefinition(u, flow.id, d)
  if (activate) {
    const res = await u.c.post(`/api/flows/${flow.id}/activate`)
    if (res.status !== 200) throw new Error(`activate → ${res.status} ${res.text}`)
  }
  return flow
}

export async function bundle(u: User, flowId: string): Promise<{ flow: Any; definition: Any }> {
  const res = await u.c.get(`/api/flows/${flowId}/editor-bundle`)
  if (res.status !== 200) throw new Error(`editor-bundle → ${res.status} ${res.text}`)
  return res.body
}

/** Upload multipart em POST /api/media (T49) → id da mídia. */
export async function uploadMedia(env: Env, u: User, bytes: Uint8Array, mime = 'image/png'): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mime }), 'foto.png')
  const res = await env.app.request('/api/media', {
    method: 'POST',
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-requested-with': 'crm', 'x-forwarded-for': '10.9.9.9' },
    body: form,
  })
  const body: Any = await res.json()
  if (res.status !== 201) throw new Error(`POST /api/media → ${res.status} ${JSON.stringify(body)}`)
  return body.media.id
}

/** GET /api/media/:id com o usuário dado → { status, bytes }. */
export async function fetchMedia(env: Env, u: User, id: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await env.app.request(`/api/media/${encodeURIComponent(id)}`, {
    headers: { cookie: `crm_session=${u.token}`, 'x-company-id': u.companyId, 'x-forwarded-for': '10.9.9.9' },
  })
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) }
}

/** Assinatura do grafo sem ids: nós por nome (tipo, posição, ações) e arestas por nome das pontas. */
export function graphShape(d: Any) {
  const nameOf = new Map<string, string>(d.nodes.map((n: Any) => [n.id, n.name]))
  const nodes = d.nodes
    .map((n: Any) => ({
      name: n.name,
      type: n.type,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      actions: [...(n.actions ?? [])].sort((a: Any, b: Any) => a.order - b.order).map((a: Any) => ({ type: a.type, order: a.order, config: a.config })),
    }))
    .sort((a: Any, b: Any) => a.name.localeCompare(b.name))
  const edges = d.edges.map((e: Any) => `${nameOf.get(e.from)} -${e.handle}-> ${nameOf.get(e.to)}`).sort()
  return { entry: nameOf.get(d.entry), nodes, edges }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
