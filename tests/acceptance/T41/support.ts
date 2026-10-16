// Apoio da suíte T41. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': registerLogicNodes(registry, { now?, publisher?, timeZone?, globals? }), evaluateCondition(cond, facts),
//   nextSmartInterval(config, now, timeZone) → { at, delayMs }, parseNumber, FlowEngine, FlowStore, FlowControl, createNodeRegistry.
// O teste usa nós "message" como marcadores: o handler registra o id do nó visitado e segue por 'source', assim o handle
// escolhido pelo nó de lógica é observado pelo caminho percorrido.
import { createDb, runMigrations } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Env {
  tmp: TempDb
  db: Any
  core: Any
  store: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  for (const n of ['FlowEngine', 'FlowStore', 'FlowControl', 'createNodeRegistry', 'registerLogicNodes', 'evaluateCondition', 'nextSmartInterval', 'parseNumber'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t41')
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  await runMigrations(db, { set: 'crm' })
  return {
    tmp,
    db,
    core,
    store: new core.FlowStore(db),
    q: async (text, params = []) => (await db.$client.query(text, params)).rows,
    close: async () => {
      await db.$client.end().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export interface World {
  companyId: string
  contactId: string
  chatId: string | null
  userId: string
}

export interface WorldOpts {
  timeZone?: string
  contactName?: string
  email?: string | null
  phone?: string
  customFields?: Record<string, unknown>
  /** sem chat: atendimento/atendente/etiqueta de chat não atendem */
  chat?: { status?: 'waiting' | 'attending' | 'resolved'; assigned?: boolean } | null
  contactLabels?: string[]
  chatLabels?: string[]
  globals?: Record<string, string>
}

export async function world(env: Env, o: WorldOpts = {}): Promise<World> {
  const slug = uniqueId('t41').toLowerCase()
  const [co] = await env.q(`INSERT INTO crm.companies (name, slug, time_zone) VALUES ($1, $2, $3) RETURNING id`, [`Empresa ${slug}`, slug, o.timeZone ?? 'America/Sao_Paulo'])
  const [u] = await env.q(`INSERT INTO crm.users (email, password_hash, name) VALUES ($1, 'x', 'Atendente') RETURNING id`, [`${slug}@example.test`])
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, email, custom_fields) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    co.id,
    o.contactName ?? 'Maria Souza',
    o.phone ?? fakePhone(),
    o.email === undefined ? 'maria@example.test' : o.email,
    JSON.stringify(o.customFields ?? {}),
  ])
  let chatId: string | null = null
  if (o.chat !== null) {
    const [cn] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, 'Conexão') RETURNING id`, [co.id, `sess-t41-${slug}`])
    const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id, status, assigned_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
      co.id,
      cn.id,
      ct.id,
      o.chat?.status ?? 'waiting',
      o.chat?.assigned ? u.id : null,
    ])
    chatId = ch.id
  }
  for (const name of o.contactLabels ?? []) {
    const [l] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') ON CONFLICT DO NOTHING RETURNING id`, [co.id, name])
    await env.q(`INSERT INTO crm.contact_labels (company_id, contact_id, label_id) VALUES ($1, $2, $3)`, [co.id, ct.id, l.id])
  }
  for (const name of o.chatLabels ?? []) {
    const [l] = await env.q(`INSERT INTO crm.labels (company_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`, [co.id, name])
    await env.q(`INSERT INTO crm.chat_labels (company_id, chat_id, label_id) VALUES ($1, $2, $3)`, [co.id, chatId, l.id])
  }
  for (const [name, value] of Object.entries(o.globals ?? {}))
    await env.q(`INSERT INTO crm.global_variables (company_id, name, type, value) VALUES ($1, $2, 'text', $3)`, [co.id, name, value])
  return { companyId: co.id, contactId: ct.id, chatId, userId: u.id }
}

/** Contato extra (mesma empresa), com chat próprio na mesma conexão, se houver. */
export async function extraContact(env: Env, w: World): Promise<{ contactId: string; chatId: string | null }> {
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [w.companyId, uniqueId('Contato'), fakePhone()])
  let chatId: string | null = null
  if (w.chatId) {
    const [ch] = await env.q(
      `INSERT INTO crm.chats (company_id, connection_id, contact_id) SELECT company_id, connection_id, $2 FROM crm.chats WHERE id = $1 RETURNING id`,
      [w.chatId, ct.id],
    )
    chatId = ch.id
  }
  return { contactId: ct.id, chatId }
}

export const action = (id: string, type: string, config: Any) => ({ id, type, order: 0, config })
export const node = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const marker = (id: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: id })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })
export const def = (nodes: Any[], edges: Any[]) => ({
  schema: 'crm.flow/v1',
  entry: 'start',
  nodes: [node('start', 'start'), ...nodes],
  edges,
  variables: [],
  refs: {},
})

/** start → L (nó de lógica) ─success→ S / ─failure→ F */
export const conditionDef = (config: Any) =>
  def([node('L', 'condition', [action('L-a', 'evaluate_condition', config)]), marker('S'), marker('F')], [edge('start', 'source', 'L'), edge('L', 'success', 'S'), edge('L', 'failure', 'F')])

export async function publishedFlow(env: Env, companyId: string, d: Any, status: 'active' | 'paused' | 'draft' = 'active'): Promise<string> {
  const ctx = { companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, d)
  if (status !== 'draft') {
    await env.store.publish(ctx, flow.id)
    await env.store.updateFlow(ctx, flow.id, { status })
  }
  return flow.id
}

export interface RunResult {
  runId: string
  visited: string[]
  status: string
  row: Any
  error: unknown
  published: Array<{ companyId: string; type: string; data: Any }>
  timers: Array<{ data: Any; delayMs: number }>
}

/**
 * Publica (ou usa) o fluxo, cria o run do contato/chat e executa até parar. Os marcadores ('message') registram a visita.
 */
export async function runFlow(
  env: Env,
  w: World,
  flow: { def?: Any; flowId?: string },
  opts: { now?: () => Date; contactId?: string; chatId?: string | null; timeZone?: string } = {},
): Promise<RunResult> {
  const flowId = flow.flowId ?? (await publishedFlow(env, w.companyId, flow.def))
  const visited: string[] = []
  const published: RunResult['published'] = []
  const timers: RunResult['timers'] = []
  const publisher = { publish: async (companyId: string, type: string, data: Any) => void published.push({ companyId, type, data }) }
  const control = new env.core.FlowControl({
    db: env.db,
    timers: { schedule: async (data: Any, delayMs: number) => void timers.push({ data, delayMs }), cancel: async () => {} },
    now: opts.now,
    shortDelayMs: 0,
    enqueueStep: async () => {},
  })
  const deps: Any = { publisher }
  if (opts.now) deps.now = opts.now
  if (opts.timeZone) deps.timeZone = async () => opts.timeZone
  const registry = env.core.registerLogicNodes(env.core.createNodeRegistry(), deps)
  registry.register('message', {
    async execute(ctx: Any) {
      visited.push(ctx.node.id)
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa: new FakeWaGateway(), registry, hooks: control.engineHooks(), now: opts.now })
  const contactId = opts.contactId ?? w.contactId
  const chatId = opts.chatId === undefined ? w.chatId : opts.chatId
  const { runId } = await engine.startRun({ companyId: w.companyId }, { flowId, contactId, ...(chatId ? { chatId } : {}) })
  let error: unknown = null
  try {
    await engine.step(runId, 0)
  } catch (err) {
    error = err
  }
  const [row] = await env.q(`SELECT * FROM crm.flow_runs WHERE id = $1`, [runId])
  return { runId, visited, status: row.status, row, error, published, timers }
}

/** Avalia uma condição por um run de verdade: 'success' ou 'failure' pelo marcador visitado. */
export async function decide(env: Env, w: World, config: Any, opts: { now?: () => Date; timeZone?: string } = {}): Promise<'success' | 'failure' | string> {
  const r = await runFlow(env, w, { def: conditionDef(config) }, opts)
  if (r.visited.includes('S')) return 'success'
  if (r.visited.includes('F')) return 'failure'
  return `nenhum (status ${r.status}, ${String(r.error ?? r.row.error)})`
}

export const at = (iso: string) => () => new Date(iso)
