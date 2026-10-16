// Postgres real + motor (T25): HTTP com variáveis e mapeamento; IA com FakeLlm, saídas condicionais, medição
// (`ai_usage.feature = 'flow_ai'`) e cota esgotada → failure com quota_exceeded.
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { FakeLlm, output, text } from '@crm/ai/testing'
import { aiQuotas, aiUsage, createDb, llmPrices, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { WalletService } from '../../../ai-usage/wallet'
import { UsageGuard } from '../../../ai-metering/guard'
import { createNodeRegistry } from '../../engine/registry'
import { FlowEngine } from '../../engine/runner'
import { FlowStore } from '../../store/store'
import { registerExternalNodes, type ExternalDeps } from './index'

let tmp: TempDatabase
let db: Database
let redis: Redis
let store: FlowStore
let server: Server
let base = ''
const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = []
const prefix = `crm:ai:used:t42-${randomBytes(4).toString('hex')}`
let n = 0

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1')
  store = new FlowStore(db)
  await db.insert(llmPrices).values({ provider: 'openai', model: 'gpt-4.1-mini', effectiveFrom: new Date('2020-01-01'), inputPerMtokMicros: 1_000_000, outputPerMtokMicros: 1_000_000 })
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      if (req.url?.startsWith('/erro')) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end('{"erro":true}')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { status: 'pago', items: [{ id: 'P-9' }] } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  const keys = await redis.keys(`${prefix}:*`)
  if (keys.length) await redis.del(...keys)
  redis.disconnect()
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T
const node = (id: string, type: string, actions: unknown[] = []) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions })
const action = (id: string, type: string, config: unknown) => ({ id, type, order: 0, config })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle.replace(':', '_')}-${to}`, from, handle, to })
const end = (id: string) => node(id, 'smart_interval', [action(`${id}-a`, 'smart_interval', { schedule_type: 'time', interval_value: 1, interval_unit: 'minutes' })])
const def = (nodes: unknown[], edges: unknown[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

async function company(credits = 1_000_000) {
  n += 1
  const co = (await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t42-${n}-${Date.now()}`}) returning id`)).id
  if (credits) await new WalletService({ db }).credit(co, credits)
  const contact = (await one<{ id: string }>(sql`insert into crm.contacts (company_id, name, phone_e164) values (${co}, 'Maria', ${`+5511944${String(n).padStart(6, '0')}`}) returning id`)).id
  return { co, contact }
}
async function run(co: string, contactId: string, d: unknown, deps: ExternalDeps, vars: Record<string, unknown> = {}) {
  const flow = await store.createFlow({ companyId: co }, { name: `F${n++}` })
  await store.fromDefinition({ companyId: co }, flow.id, d)
  await store.publish({ companyId: co }, flow.id)
  // Os nós finais do teste esperam (timer): encerra o run anterior do contato.
  await db.execute(sql`update crm.flow_runs set status = 'completed' where contact_id = ${contactId} and status in ('running', 'waiting')`)
  const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry: registerExternalNodes(createNodeRegistry(), deps) })
  const { runId } = await engine.startRun({ companyId: co }, { flowId: flow.id, contactId, vars })
  await engine.step(runId, 0)
  return one<{ status: string; current_node_key: string | null; vars: Record<string, unknown>; error: string | null }>(sql`select status, current_node_key, vars, error from crm.flow_runs where id = ${runId}`)
}

describe('make_http_request', () => {
  const http = { allowHosts: ['127.0.0.1'] }
  it('método, headers e corpo com variáveis; mapeia a resposta; não 2xx segue failure', async () => {
    const w = await company()
    const flow = (path: string) =>
      def(
        [
          node('H', 'integration', [
            action('h', 'make_http_request', {
              request_method: 'POST',
              request_url: `${base}${path}?id={pedido}`,
              request_headers: { Authorization: 'Bearer {token}' },
              request_body: { pedido: '{pedido}', fixo: 1 },
              response_mapping: { status_pagamento: 'data.status', item: 'data.items.0.id' },
            }),
          ]),
          end('S'),
          end('F'),
        ],
        [edge('start', 'source', 'H'), edge('H', 'success', 'S'), edge('H', 'failure', 'F')],
      )
    const ok = await run(w.co, w.contact, flow('/ok'), { http }, { pedido: '42', token: 'tk' })
    expect(ok.current_node_key).toBe('S')
    expect(ok.vars).toMatchObject({ status_pagamento: 'pago', item: 'P-9', response: { status: 200, ok: true } })
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/ok?id=42', auth: 'Bearer tk' })
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ pedido: '42', fixo: 1 })
    const bad = await run(w.co, w.contact, flow('/erro'), { http }, { pedido: '1', token: 'x' })
    expect(bad.current_node_key).toBe('F')
    expect(bad.vars).toMatchObject({ http_error: 'http_status_500', response: { status: 500 } })
    // sem liberar o host local: SSRF bloqueia
    const ssrf = await run(w.co, w.contact, flow('/ok'), {}, { pedido: '1', token: 'x' })
    expect([ssrf.current_node_key, ssrf.vars.http_error]).toEqual(['F', 'ssrf_blocked'])
  })
})

describe('ai_call', () => {
  const cond = (extra: Record<string, unknown> = {}) =>
    def(
      [
        node('A', 'ai', [
          action('a', 'ai_call', {
            provider: 'gpt',
            user_message: 'Quero comprar {produto}',
            output_conditions: [
              { prompt: 'quer comprar', output_key: 'compra' },
              { prompt: 'quer suporte', output_key: 'suporte' },
            ],
            fallback_output_key: 'outros',
            ...extra,
          }),
        ]),
        end('C'),
        end('S'),
        end('O'),
        end('F'),
      ],
      [edge('start', 'source', 'A'), edge('A', 'output:compra', 'C'), edge('A', 'output:suporte', 'S'), edge('A', 'output:outros', 'O'), edge('A', 'failure', 'F')],
    )

  it('structured output segue a saída; inválida vai para a padrão; medição flow_ai', async () => {
    const w = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    const llm = new FakeLlm([output({ output_key: 'compra' }, { usage: { inputTokens: 50, outputTokens: 5 } }), output({ output_key: 'xyz' })])
    const r1 = await run(w.co, w.contact, cond(), { llm, guard }, { produto: 'curso' })
    expect(r1.current_node_key, JSON.stringify(r1.vars)).toBe('C')
    expect(r1.vars).toMatchObject({ ai: { output: 'compra', fail: { reason: null } } })
    expect(llm.calls[0]!.messages.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Quero comprar curso' }] })
    const r2 = await run(w.co, w.contact, cond(), { llm, guard })
    expect(r2.current_node_key).toBe('O')
    const usage = await db.select().from(aiUsage).where(eq(aiUsage.companyId, w.co))
    expect(usage).toHaveLength(2)
    expect(usage.every((u) => u.feature === 'flow_ai')).toBe(true)
  })

  it('sem condições: texto em ai.response e success; cota esgotada → failure quota_exceeded sem chamar o LLM', async () => {
    const w = await company()
    const guard = new UsageGuard({ db, redis, prefix })
    const llm = new FakeLlm([text('Olá, Maria!')])
    const free = def(
      [node('A', 'ai', [action('a', 'ai_call', { provider: 'gpt', user_message: 'oi', response_variable: 'resposta' })]), end('S'), end('F')],
      [edge('start', 'source', 'A'), edge('A', 'success', 'S'), edge('A', 'failure', 'F')],
    )
    const ok = await run(w.co, w.contact, free, { llm, guard })
    expect(ok.current_node_key).toBe('S')
    expect(ok.vars).toMatchObject({ resposta: 'Olá, Maria!', ai: { response: 'Olá, Maria!' } })

    await db.insert(aiQuotas).values({ companyId: w.co, period: 'month', maxCredits: 1, hard: true })
    await guard.commit({ requestId: `r-${n}`, companyId: w.co, provider: 'openai', model: 'gpt-4.1-mini', feature: 'test', usage: { inputTokens: 100_000, outputTokens: 0 } })
    const blocked = new FakeLlm([text('não deveria')])
    const r = await run(w.co, w.contact, cond({ fail_reason_variable: 'motivo' }), { llm: blocked, guard })
    expect(r.current_node_key).toBe('F')
    expect(r.vars).toMatchObject({ motivo: 'quota_exceeded', ai: { fail: { reason: 'quota_exceeded' } } })
    expect(blocked.callCount).toBe(0)
  })

  it('sem provedor configurado → failure provider_not_configured', async () => {
    const w = await company()
    const r = await run(w.co, w.contact, cond(), {})
    expect(r.current_node_key).toBe('F')
    expect((r.vars.ai as { fail: { reason: string } }).fail.reason).toBe('provider_not_configured')
  })
})
