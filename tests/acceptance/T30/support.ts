// Apoio da suíte T30. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': FlowEngine (T25), createNodeRegistry, FlowStore, FlowControl({ db, timers?, enqueueStep?, now?, shortDelayMs? }),
//   control.engineHooks(), control.resolveReply(runId, inbound), control.fireTimer({ runId, seq, gen? }),
//   control.cancel(runId), control.pauseFlow(ctx, flowId), control.resumeFlow(ctx, flowId),
//   waitForReply({ delayMs?, now? }), waitDelay(ms, { now? }), bullTimerScheduler(queue), flowTimerJobId(data), defineQueue.
// '@crm/worker': createFlowTimerProcessor({ control }), FLOW_TIMER_QUEUE.
import { randomBytes } from 'node:crypto'
import { createDb, runMigrations } from '@crm/db'
import { bullConnection } from '@crm/node-kit'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const MIN = 60_000
export const DAY = 24 * 60 * MIN

export interface Env {
  tmp: TempDb
  db: Any
  core: Any
  store: Any
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  queues: Any[]
  close: () => Promise<void>
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  for (const n of ['FlowEngine', 'FlowControl', 'createNodeRegistry', 'waitForReply', 'waitDelay', 'bullTimerScheduler', 'flowTimerJobId', 'FlowStore'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t30')
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  await runMigrations(db, { set: 'crm' })
  const queues: Any[] = []
  return {
    tmp,
    db,
    core,
    store: new core.FlowStore(db),
    q: async (text, params = []) => (await db.$client.query(text, params)).rows,
    queues,
    close: async () => {
      for (const qq of queues) {
        await qq.obliterate?.({ force: true }).catch(() => {})
        await qq.close().catch(() => {})
      }
      await db.$client.end().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export async function loadWorker(): Promise<Any> {
  const w: Any = await import('@crm/worker')
  if (typeof w.createFlowTimerProcessor !== 'function') throw new Error('@crm/worker não exporta createFlowTimerProcessor')
  return w
}

/** Fila BullMQ real 'flow-timer' com prefixo aleatório (Redis db 1). */
export function timerQueue(env: Env): Any {
  const queue = env.core.defineQueue('flow-timer', { prefix: `t30${randomBytes(4).toString('hex')}`, connection: bullConnection() })
  env.queues.push(queue)
  return queue
}

/** Agendador falso que registra as chamadas. */
export function fakeTimers() {
  const scheduled: Array<{ data: Any; delayMs: number }> = []
  const cancelled: Any[] = []
  return {
    scheduled,
    cancelled,
    scheduler: {
      schedule: async (data: Any, delayMs: number) => void scheduled.push({ data, delayMs }),
      cancel: async (data: Any) => void cancelled.push(data),
    },
  }
}

export async function newCompany(env: Env): Promise<string> {
  const slug = uniqueId('t30').toLowerCase()
  const [r] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Empresa ${slug}`, slug])
  return r.id
}

export async function newContact(env: Env, companyId: string): Promise<string> {
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Contato ${uniqueId('ct')}`, fakePhone()])
  return r.id
}

const CONFIG: Record<string, [string, Any]> = {
  message: ['send_message', { message_text: 'oi' }],
  wait_response: ['wait_for_response', { wait_indefinitely: false, timeout_value: 1, timeout_unit: 'hours' }],
  smart_interval: ['smart_interval', { schedule_type: 'time', interval_value: 1, interval_unit: 'hours' }],
  integration: ['make_http_request', { request_method: 'GET', request_url: 'https://example.test/x' }],
}

export const node = (id: string, type = 'message', config?: Any) => ({
  id,
  type,
  name: `Nó ${id}`,
  position: { x: 0, y: 0 },
  actions: type === 'start' ? [] : [{ id: `${id}-a1`, type: CONFIG[type]![0], order: 0, config: config ?? CONFIG[type]![1] }],
})

export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })

export const definition = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

/** start → W (espera) ─source→ R (resposta) / ─timeout→ T (timeout) */
export const replyFlow = (waitType = 'wait_response') =>
  definition([node('W', waitType), node('R'), node('T')], [edge('start', 'source', 'W'), edge('W', 'source', 'R'), edge('W', 'timeout', 'T')])

export async function publishedFlow(env: Env, companyId: string, def: Any): Promise<string> {
  const ctx = { companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, def)
  await env.store.publish(ctx, flow.id)
  return flow.id
}

export async function runRow(env: Env, runId: string) {
  const [r] = await env.q(`SELECT status, seq, wait, vars, error, current_node_key FROM crm.flow_runs WHERE id = $1`, [runId])
  return r
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Harness {
  companyId: string
  flowId: string
  runId: string
  engine: Any
  control: Any
  visited: string[]
  enqueued: Array<{ runId: string; expectedSeq: number }>
  /** executa os passos enfileirados pelo controle */
  drain: () => Promise<void>
}

/**
 * Monta fluxo publicado + contato + FlowControl + FlowEngine (hooks do controle) e já executa o 1º passo
 * (o run para no nó de espera). `waitFor` diz o que o nó W devolve.
 */
export async function harness(
  env: Env,
  waitFor: () => Any,
  opts: { timers?: Any; now?: () => Date; shortDelayMs?: number; def?: Any } = {},
): Promise<Harness> {
  const companyId = await newCompany(env)
  const contactId = await newContact(env, companyId)
  const flowId = await publishedFlow(env, companyId, opts.def ?? replyFlow())
  const visited: string[] = []
  const enqueued: Array<{ runId: string; expectedSeq: number }> = []
  const control = new env.core.FlowControl({
    db: env.db,
    timers: opts.timers,
    now: opts.now,
    shortDelayMs: opts.shortDelayMs,
    enqueueStep: async (job: Any) => void enqueued.push(job),
  })
  const registry = env.core.createNodeRegistry()
  const waiter = {
    async execute(ctx: Any) {
      visited.push(ctx.node.id)
      return { wait: waitFor() }
    },
  }
  registry.register('wait_response', waiter)
  registry.register('smart_interval', waiter)
  registry.register('message', {
    async execute(ctx: Any) {
      visited.push(ctx.node.id)
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa: {}, registry, hooks: control.engineHooks(), now: opts.now })
  const { runId } = await engine.startRun({ companyId }, { flowId, contactId })
  await engine.step(runId, 0)
  const drain = async () => {
    while (enqueued.length) {
      const j = enqueued.shift()!
      await engine.step(j.runId, j.expectedSeq)
    }
  }
  return { companyId, flowId, runId, engine, control, visited, enqueued, drain }
}
