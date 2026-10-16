// Apoio da suíte T63. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': createNodeRegistry() (já com os nós de CRM), registerCrmNodes(registry, { publisher?, now?, timeZone? }),
//   FlowEngine, FlowStore. Os nós só têm 'source'; erro → aresta 'failure' se existir, senão o run termina failed.
// Eventos capturados por um publisher falso (contact.updated, chat.updated, kanban.*, notification.created).
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
  for (const n of ['FlowEngine', 'FlowStore', 'createNodeRegistry', 'registerCrmNodes']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t63')
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
  chatId: string
  connectionId: string
  userId: string
}

export async function world(env: Env, o: { timeZone?: string; customFields?: Record<string, unknown>; contactName?: string; chatStatus?: string } = {}): Promise<World> {
  const slug = uniqueId('t63').toLowerCase()
  const [co] = await env.q(`INSERT INTO crm.companies (name, slug, time_zone) VALUES ($1, $2, $3) RETURNING id`, [`Empresa ${slug}`, slug, o.timeZone ?? 'America/Sao_Paulo'])
  const [u] = await env.q(`INSERT INTO crm.users (email, password_hash, name) VALUES ($1, 'x', 'Atendente') RETURNING id`, [`${slug}@example.test`])
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, custom_fields) VALUES ($1, $2, $3, $4) RETURNING id`, [
    co.id,
    o.contactName ?? 'Maria Souza',
    fakePhone(),
    JSON.stringify(o.customFields ?? {}),
  ])
  const [cn] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, 'Conexão') RETURNING id`, [co.id, `sess-t63-${slug}`])
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id, status, assigned_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    co.id,
    cn.id,
    ct.id,
    o.chatStatus ?? 'waiting',
    o.chatStatus === 'attending' ? u.id : null,
  ])
  return { companyId: co.id, contactId: ct.id, chatId: ch.id, connectionId: cn.id, userId: u.id }
}

export const action = (id: string, type: string, config: Any, order = 0) => ({ id, type, order, config })
export const node = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const marker = (id: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: id })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })
export const def = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

/** start → X (o nó testado) ─source→ OK / ─failure→ FAIL (opcional) */
export const single = (type: string, actType: string, config: Any, withFailure = true) =>
  def(
    [node('X', type, [action('X-a', actType, config)]), marker('OK'), ...(withFailure ? [marker('FAIL')] : [])],
    [edge('start', 'source', 'X'), edge('X', 'source', 'OK'), ...(withFailure ? [edge('X', 'failure', 'FAIL')] : [])],
  )

export interface RunResult {
  runId: string
  visited: string[]
  status: string
  error: string | null
  published: Array<{ companyId: string; type: string; data: Any }>
}

export async function runFlow(env: Env, w: World, d: Any, opts: { now?: () => Date; chatId?: string | null } = {}): Promise<RunResult> {
  const ctx = { companyId: w.companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, d)
  await env.store.publish(ctx, flow.id)
  await env.store.updateFlow(ctx, flow.id, { status: 'active' })
  const published: RunResult['published'] = []
  const visited: string[] = []
  const publisher = { publish: async (companyId: string, type: string, data: Any) => void published.push({ companyId, type, data }) }
  const registry = env.core.registerCrmNodes(env.core.createNodeRegistry(), { publisher, ...(opts.now ? { now: opts.now } : {}) })
  registry.register('message', {
    async execute(c: Any) {
      visited.push(c.node.id)
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa: new FakeWaGateway(), registry, now: opts.now })
  const chatId = opts.chatId === undefined ? w.chatId : opts.chatId
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: w.contactId, ...(chatId ? { chatId } : {}) })
  try {
    await engine.step(runId, 0)
  } catch {
    /* o estado do run é conferido abaixo */
  }
  const [row] = await env.q(`SELECT status, error FROM crm.flow_runs WHERE id = $1`, [runId])
  return { runId, visited, status: row.status, error: row.error, published }
}

export const ofType = (r: RunResult, type: string) => r.published.filter((p) => p.type === type)

export async function contactLabels(env: Env, contactId: string): Promise<string[]> {
  return (await env.q(`SELECT l.name FROM crm.contact_labels cl JOIN crm.labels l ON l.id = cl.label_id WHERE cl.contact_id = $1 ORDER BY l.name`, [contactId])).map((r: Any) => r.name)
}

export async function chatRow(env: Env, chatId: string) {
  return (await env.q(`SELECT * FROM crm.chats WHERE id = $1`, [chatId]))[0]
}

export async function chatEvents(env: Env, chatId: string) {
  return env.q(`SELECT type, detail FROM crm.chat_events WHERE chat_id = $1 ORDER BY created_at`, [chatId])
}

export async function board(env: Env, companyId: string) {
  const [b] = await env.q(`INSERT INTO crm.crms (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, uniqueId('Funil')])
  const cols: string[] = []
  for (const [i, name] of ['Novo', 'Qualificação', 'Ganho'].entries()) {
    const [c] = await env.q(`INSERT INTO crm.crm_columns (company_id, crm_id, name, position, conversion_goal) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [companyId, b.id, name, i, i === 2])
    cols.push(c.id)
  }
  return { id: b.id as string, columns: cols }
}
