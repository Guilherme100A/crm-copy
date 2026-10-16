// Apoio da suíte T42. Superfície pública combinada com o Operário (Bigorna):
// '@crm/core': registerExternalNodes(registry, { http?: { timeoutMs, maxRedirects, lookup, allowHosts }, llm?, guard? }),
//   isBlockedAddress(ip), FlowEngine, FlowStore, createNodeRegistry, UsageGuard (T24).
// HTTP real contra um servidor local (liberado só por http.allowHosts: ['127.0.0.1']); sem allowHosts, 127.0.0.1 é bloqueado.
// Nós "message" são marcadores do handle seguido.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDb, runMigrations } from '@crm/db'
import { redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createTempDb, dropTempDb, type TempDb } from '../helpers/pg'
import { fakePhone, uniqueId } from '../helpers/factories'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface Env {
  tmp: TempDb
  db: Any
  core: Any
  ai: Any
  store: Any
  redis: Any
  server: Server
  base: string
  requests: Recorded[]
  q: (text: string, params?: unknown[]) => Promise<Any[]>
  close: () => Promise<void>
}

/** Rotas do servidor local: /ok (JSON), /status/<n>, /slow, /redirect?to=<url>, /text, /big. */
function startServer(requests: Recorded[]): Promise<Server> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-trace': 'abc' })
        res.end(JSON.stringify({ data: { status: 'pago', total: 99.9, items: [{ id: 42 }, { id: 43 }] }, echo: body ? JSON.parse(body) : null }))
      } else if (u.pathname.startsWith('/status/')) {
        const code = Number(u.pathname.split('/')[2])
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ erro: `falhou ${code}` }))
      } else if (u.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"late":true}')
        }, 3_000)
      } else if (u.pathname === '/redirect') {
        res.writeHead(302, { location: u.searchParams.get('to') ?? '/ok' })
        res.end()
      } else if (u.pathname === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('olá texto')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

export async function startEnv(): Promise<Env> {
  const core: Any = await import('@crm/core')
  const ai: Any = await import('@crm/ai/testing')
  for (const n of ['FlowEngine', 'FlowStore', 'createNodeRegistry', 'registerExternalNodes', 'isBlockedAddress', 'UsageGuard'])
    if (core[n] === undefined) throw new Error(`@crm/core não exporta ${n}`)
  const tmp = createTempDb('crm_acc_t42')
  const db = createDb(tmp.url)
  db.$client.on?.('error', () => {})
  await runMigrations(db, { set: 'crm' })
  const redis = redisConnection({})
  redis.on?.('error', () => {})
  const requests: Recorded[] = []
  const server = await startServer(requests)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const q = async (text: string, params: unknown[] = []) => (await db.$client.query(text, params)).rows
  // preço do modelo padrão do provedor 'gpt' (o UsageGuard recusa modelo sem preço)
  await q(
    `INSERT INTO crm.llm_prices (provider, model, kind, effective_from, input_per_mtok_micros, output_per_mtok_micros)
     SELECT 'openai', 'gpt-4.1-mini', 'llm', '2020-01-01T00:00:00Z', 1000000, 2000000
      WHERE NOT EXISTS (SELECT 1 FROM crm.llm_prices WHERE provider = 'openai' AND model = 'gpt-4.1-mini')`,
  )
  return {
    tmp,
    db,
    core,
    ai,
    store: new core.FlowStore(db),
    redis,
    server,
    base,
    requests,
    q,
    close: async () => {
      await new Promise((r) => server.close(() => r(null)))
      await Promise.resolve(redis.quit?.()).catch(() => redis.disconnect?.())
      await db.$client.end().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export async function company(env: Env, o: { wallet?: number | null; contactName?: string } = {}) {
  const slug = uniqueId('t42').toLowerCase()
  const [co] = await env.q(`INSERT INTO crm.companies (name, slug) VALUES ($1, $2) RETURNING id`, [`Empresa ${slug}`, slug])
  const [ct] = await env.q(`INSERT INTO crm.contacts (company_id, name, phone_e164, custom_fields) VALUES ($1, $2, $3, '{"pedido":"P-77"}') RETURNING id`, [
    co.id,
    o.contactName ?? 'Maria Souza',
    fakePhone(),
  ])
  if (o.wallet !== null)
    await env.q(`INSERT INTO crm.ai_wallets (company_id, balance_credits, status) VALUES ($1, $2, $3)`, [co.id, o.wallet ?? 1_000_000_000, (o.wallet ?? 1) > 0 ? 'ok' : 'exhausted'])
  return { companyId: co.id as string, contactId: ct.id as string }
}

export const action = (id: string, type: string, config: Any) => ({ id, type, order: 0, config })
export const node = (id: string, type: string, actions: Any[] = []) => ({ id, type, name: `Nó ${id}`, position: { x: 0, y: 0 }, actions })
export const marker = (id: string) => node(id, 'message', [action(`${id}-a`, 'send_message', { message_text: id })])
export const edge = (from: string, handle: string, to: string) => ({ id: `e-${from}-${handle}-${to}`.replace(/[^a-zA-Z0-9-]/g, '_'), from, handle, to })
export const def = (nodes: Any[], edges: Any[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

/** start → H (integration) ─success→ S / ─failure→ F */
export const httpDef = (config: Any) =>
  def([node('H', 'integration', [action('H-a', 'make_http_request', config)]), marker('S'), marker('F')], [edge('start', 'source', 'H'), edge('H', 'success', 'S'), edge('H', 'failure', 'F')])

export interface RunResult {
  visited: string[]
  status: string
  vars: Any
  error: string | null
}

export async function run(env: Env, c: { companyId: string; contactId: string }, d: Any, deps: Any): Promise<RunResult> {
  const ctx = { companyId: c.companyId }
  const flow = await env.store.createFlow(ctx, { name: uniqueId('Fluxo') })
  await env.store.fromDefinition(ctx, flow.id, d)
  await env.store.publish(ctx, flow.id)
  await env.store.updateFlow(ctx, flow.id, { status: 'active' })
  const visited: string[] = []
  const registry = env.core.registerExternalNodes(env.core.createNodeRegistry(), deps)
  registry.register('message', {
    async execute(x: Any) {
      visited.push(x.node.id)
      return { next: 'source' }
    },
  })
  const engine = new env.core.FlowEngine({ db: env.db, wa: new FakeWaGateway(), registry })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: c.contactId })
  try {
    await engine.step(runId, 0)
  } catch {
    /* estado conferido abaixo */
  }
  const [row] = await env.q(`SELECT status, vars, error FROM crm.flow_runs WHERE id = $1`, [runId])
  return { visited, status: row.status, vars: row.vars ?? {}, error: row.error }
}

/** Deps de HTTP liberando só o servidor local. */
export const local = (extra: Any = {}) => ({ http: { allowHosts: ['127.0.0.1'], timeoutMs: 1_000, ...extra } })
