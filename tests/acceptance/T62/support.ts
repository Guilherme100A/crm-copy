// Apoio da suíte T62. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': createNodeRegistry() (já com os nós interativos), registerInteractiveNodes(registry, { sleep?, now?, rng? }),
//   menuText, matchOption, normalizeAnswer, FlowEngine, FlowStore, FlowControl (T30, com reentry: a resposta volta ao nó).
// Resposta do lead: control.resolveReply(runId, { text }) → flow-step enfileirado → engine.step. Prazo: control.fireTimer.
// Envio pela conexão do chat (crm.chats → crm.connections.session_id) no FakeWaGateway, que registra em `sent`.
// Os nós "message" são marcadores: registram o id visitado e seguem por 'source' (assim o handle escolhido é observado).
import { createDb, runMigrations } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { uniqueId } from '../helpers/factories'

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
  for (const n of ['FlowEngine', 'FlowStore', 'FlowControl', 'createNodeRegistry', 'registerInteractiveNodes', 'matchOption', 'normalizeAnswer'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t62')
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

export const action = (id: string, type: string, config: Any, order = 0) => ({ id, type, order, config })
export const node = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const marker = (id: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: id })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })
export const def = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

export interface Session {
  companyId: string
  contactId: string
  phone: string
  wa: Any
  runId: string
  engine: Any
  control: Any
  visited: string[]
  timers: Array<{ data: Any; delayMs: number }>
  clock: { t: number }
  /** resposta do lead + execução dos passos enfileirados */
  reply: (text: string, type?: string) => Promise<Any>
  /** dispara o último timer agendado (prazo ou janela do buffer) e executa os passos */
  fireLastTimer: () => Promise<Any>
  run: () => Promise<Any>
  /** conteúdos enviados ao gateway (em ordem) */
  sent: () => Any[]
}

/**
 * Empresa + contato "Maria Souza" + conexão (sessão no FakeWaGateway) + chat; publica a definição, cria o run e executa
 * o 1º passo (o run para na espera do nó interativo).
 */
export async function session(env: Env, d: Any, opts: { now?: number; capabilities?: Any } = {}): Promise<Session> {
  const slug = uniqueId('t62').toLowerCase()
  const [co] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Empresa ${slug}`, slug])
  const phone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, 'Maria Souza', $2) RETURNING id`, [co.id, phone])
  const sessionId = `sess-${slug}`
  const wa = new FakeWaGateway({ sessions: [{ id: sessionId }], ...(opts.capabilities ? { capabilities: opts.capabilities } : {}) })
  const [cn] = await env.q(`INSERT INTO crm.connections (company_id, session_id, name) VALUES ($1, $2, 'Conexão') RETURNING id`, [co.id, sessionId])
  const [ch] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [co.id, cn.id, ct.id])

  const ctx = { companyId: co.id }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, d)
  await env.store.publish(ctx, flow.id)
  await env.store.updateFlow(ctx, flow.id, { status: 'active' })

  const clock = { t: opts.now ?? Date.parse('2026-10-19T13:00:00Z') }
  const now = () => new Date(clock.t)
  const visited: string[] = []
  const timers: Session['timers'] = []
  const queue: Array<{ runId: string; expectedSeq: number }> = []
  const control = new env.core.FlowControl({
    db: env.db,
    timers: { schedule: async (data: Any, delayMs: number) => void timers.push({ data, delayMs }), cancel: async () => {} },
    enqueueStep: async (j: Any) => void queue.push(j),
    now,
    shortDelayMs: 0,
  })
  const registry = env.core.registerInteractiveNodes(env.core.createNodeRegistry(), { sleep: async () => {}, now })
  registry.register('message', {
    async execute(c: Any) {
      visited.push(c.node.id)
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa, registry, hooks: control.engineHooks(), now })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: ct.id, chatId: ch.id })
  await engine.step(runId, 0)
  const drain = async () => {
    while (queue.length) {
      const j = queue.shift()!
      await engine.step(j.runId, j.expectedSeq)
    }
  }
  const run = async () => (await env.q(`SELECT status, seq, wait, vars, current_node_key, error FROM crm.flow_runs WHERE id = $1`, [runId]))[0]
  return {
    companyId: co.id,
    contactId: ct.id,
    phone,
    wa,
    runId,
    engine,
    control,
    visited,
    timers,
    clock,
    run,
    reply: async (text: string, type = 'text') => {
      const res = await control.resolveReply(runId, { text, type, message_id: uniqueId('m') })
      await drain()
      return res
    },
    fireLastTimer: async () => {
      const t = timers[timers.length - 1]
      if (!t) throw new Error('nenhum timer agendado')
      const res = await control.fireTimer(t.data)
      await drain()
      return res
    },
    sent: () => wa.sent.map((m: Any) => m.content),
  }
}

export async function customFields(env: Env, contactId: string) {
  return (await env.q(`SELECT custom_fields FROM crm.contacts WHERE id = $1`, [contactId]))[0].custom_fields
}
