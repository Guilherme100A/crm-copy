// Apoio da suíte T25. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': FlowEngine({ db, wa, registry?, hooks?, maxStepsPerJob? }), engine.startRun(ctx, { flowId, contactId }) → { runId, expectedSeq },
//   engine.step(runId, expectedSeq) → { executed, status?, reason? }, engine.dryRun(ctx, { flowId, registry? }),
//   createNodeRegistry() / registry.register(type, { execute(ctx) }), dryRun({ definition, registry?, contact?, vars? }), FlowStore.
// '@crm/worker': createFlowStepProcessor({ engine }) → processor({ data: { runId, expectedSeq } }).
// Handler: execute(ctx) → { next: handle } | { wait } | { end } | { jump }; ctx.wa.send(req, { actionId }) idempotente.
import { createDb, runMigrations } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const SESSION_ID = 'sess-t25'

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
  for (const n of ['FlowEngine', 'createNodeRegistry', 'dryRun', 'FlowStore']) if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t25')
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  await runMigrations(db, { set: 'crm' })
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  return {
    tmp,
    db,
    core,
    store: new core.FlowStore(db),
    q,
    close: async () => {
      await db.$client.end().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export async function loadWorker(): Promise<Any> {
  const w: Any = await import('@crm/worker')
  if (typeof w.createFlowStepProcessor !== 'function') throw new Error('@crm/worker não exporta createFlowStepProcessor')
  return w
}

export const newGateway = () => new FakeWaGateway({ sessions: [{ id: SESSION_ID }] })

export async function newCompany(env: Env): Promise<string> {
  const slug = uniqueId('t25').toLowerCase()
  const [r] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Empresa ${slug}`, slug])
  return r.id
}

export async function newContact(env: Env, companyId: string): Promise<{ id: string; phone: string }> {
  const phone = fakePhone()
  const [r] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164) VALUES ($1, $2, $3) RETURNING id`, [companyId, `Contato ${uniqueId('ct')}`, phone])
  return { id: r.id, phone }
}

const MSG = { message_text: 'Olá {first_name}' }

/** Nó genérico: tipo existente no catálogo (o comportamento vem do handler registrado no teste). */
export const node = (id: string, type = 'message') => ({
  id,
  type,
  name: `Nó ${id}`,
  position: { x: 0, y: 0 },
  actions: type === 'start' ? [] : [{ id: `${id}-a1`, type: type === 'message' ? 'send_message' : 'make_http_request', order: 0, config: type === 'message' ? MSG : { request_method: 'GET', request_url: 'https://example.test/x' } }],
})

export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })

export function definition(nodes: Any[], edges: Any[]) {
  return { schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} }
}

/** Cria fluxo com a definição, publica e devolve o flowId. */
export async function publishedFlow(env: Env, companyId: string, def: Any): Promise<string> {
  const ctx = { companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, def)
  await env.store.publish(ctx, flow.id)
  return flow.id
}

export async function runRow(env: Env, runId: string) {
  const [r] = await env.q(`SELECT status, error, seq FROM crm.flow_runs WHERE id = $1`, [runId])
  return r
}

/** Passos de nó (action_key nulo), em ordem. */
export async function nodeSteps(env: Env, runId: string) {
  return env.q(`SELECT seq, node_key, status, error, result FROM crm.flow_run_steps WHERE run_id = $1 AND action_key IS NULL ORDER BY seq, created_at`, [runId])
}

export async function counts(env: Env) {
  const [r] = await env.q(`SELECT (SELECT count(*)::int FROM crm.flow_runs) AS runs, (SELECT count(*)::int FROM crm.flow_run_steps) AS steps`)
  return r as { runs: number; steps: number }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Handler que registra a visita e segue pelo handle dado. */
export const passThrough = (visited: string[], handle = 'source', delayMs = 0) => ({
  async execute(ctx: Any) {
    visited.push(ctx.node?.id ?? ctx.node?.key ?? ctx.node)
    if (delayMs) await sleep(delayMs)
    return { next: handle }
  },
})

/** Gateway que falha se for tocado (prova que o caminho não usa o gateway real). */
export function explodingGateway(): Any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined
        throw new Error(`gateway real tocado: ${String(prop)}`)
      },
    },
  )
}
