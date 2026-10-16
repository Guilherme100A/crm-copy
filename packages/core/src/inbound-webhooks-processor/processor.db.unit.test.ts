// Processador dos webhooks de entrada contra Postgres/Redis reais (AC-T81-01..04): ordem e registro dos passos,
// dedupe por corpo em 10 min, condições any/all, conexão pelos 8 últimos dígitos e escuta de amostra.
import { createHash, randomBytes } from 'node:crypto'
import { companies, connections, contacts, createDb, flowRuns, inboundWebhookRequests, inboundWebhooks, kanbanCards, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowControl } from '../flows/engine/control'
import { FlowEngine } from '../flows/engine/runner'
import { FlowStore } from '../flows/store/store'
import { InboundWebhooksService } from '../inbound-webhooks/service'
import { KanbanService, systemActor } from '../kanban/service'
import { LabelsService } from '../labels/service'
import { InboundWebhookProcessor } from './processor'
import { SampleListeners } from './samples'

let tmp: TempDatabase
let db: Database
let redis: Redis
const published: { companyId: string; type: string; data: Record<string, unknown>; opts: Record<string, unknown> }[] = []

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 6 })
  redis = redisConnection()
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await redis?.quit()
  await tmp?.drop()
})

const rnd = () => randomBytes(4).toString('hex')
const publisher = { publish: async (companyId: string, type: string, data: unknown, opts: unknown = {}) => (published.push({ companyId, type, data: data as never, opts: opts as never }), '1-0') }
const processor = () => {
  const control = new FlowControl({ db })
  return new InboundWebhookProcessor({ db, engine: new FlowEngine({ db, wa: new FakeWaGateway(), enqueue: async () => undefined }), control, publisher: publisher as never, redis })
}
const path = (value: string) => [{ kind: 'path' as const, value }]

async function company() {
  const [c] = await db.insert(companies).values({ name: `W${rnd()}`, slug: `w-t81-${rnd()}` }).returning({ id: companies.id })
  return c!.id
}
async function connection(companyId: string, phone: string, state: 'open' | 'close' = 'open') {
  const [c] = await db.insert(connections).values({ companyId, sessionId: `s-${rnd()}`, name: `Conexão ${phone}`, phoneNumber: phone, connectionState: state }).returning({ id: connections.id })
  return c!.id
}
async function webhook(companyId: string, config: Record<string, unknown>, connectionId: string | null = null) {
  return new InboundWebhooksService({ db }).create(companyId, { name: 'Webhook teste', connection_id: connectionId, config })
}
/** Recebe como a rota pública da T72 (grava `pending`) e devolve os dados do job. */
async function receive(companyId: string, webhookId: string, body: unknown, at?: Date) {
  const svc = new InboundWebhooksService({ db, ...(at ? { now: () => at } : {}) })
  const [row] = await db.select().from(inboundWebhooks).where(eq(inboundWebhooks.id, webhookId))
  const text = JSON.stringify(body)
  const r = await svc.receive(row!, { text, truncated: false, size: text.length, hash: createHash('sha256').update(text).digest('hex'), contentType: 'application/json' })
  if (r.outcome === 'not_found') throw new Error('não recebido')
  return { requestId: r.requestId, webhookId, companyId }
}
const request = async (id: string) => (await db.select().from(inboundWebhookRequests).where(eq(inboundWebhookRequests.id, id)))[0]!
const lead = (over: Record<string, unknown> = {}) => ({ cliente: { nome: 'Ana Lima', fone: `1198${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, email: `ana.${rnd()}@x.com`, cpf: '123.456.789-00' }, instancia: { numero: '' }, ...over })

async function publishedFlow(companyId: string) {
  const store = new FlowStore(db)
  const flow = await store.createFlow({ companyId }, { name: `F${rnd()}` })
  await store.fromDefinition({ companyId }, flow.id, {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'start', position: { x: 0, y: 0 }, actions: [] },
      { id: 'm', type: 'message', name: 'm', position: { x: 0, y: 0 }, actions: [{ id: 'a', type: 'send_message', order: 0, config: { message_type: 'text', text: 'Oi {nome}' } }] },
    ],
    edges: [{ id: 'e', from: 'start', handle: 'source', to: 'm' }],
    variables: [],
    refs: {},
  })
  await store.publish({ companyId }, flow.id)
  return flow.id
}

describe('InboundWebhookProcessor', () => {
  it('AC-T81-01: passos na ordem de 09 §5 com ok/failed/skipped e motivo; dispara o fluxo cancelando o anterior', async () => {
    const co = await company()
    const phone = '+55 (11) 3333-4444'
    const conn = await connection(co, phone)
    await new LabelsService(db).create(co, { name: 'Lead Quente', color: '#FF0000' })
    const kanban = new KanbanService({ db })
    const board = await kanban.createBoard(systemActor(co), { name: 'Funil' })
    const column = await kanban.createColumn(systemActor(co), board.id, { name: 'Novo' })
    const flowId = await publishedFlow(co)
    const hook = await webhook(co, {
      field_paths: { full_name: path('cliente.nome'), phone: [{ kind: 'literal', value: '+55' }, ...path('cliente.fone')], email: path('cliente.email') },
      custom_field_mappings: [{ field_key: 'cpf', segments: path('cliente.cpf') }],
      add_tags: [' lead quente ', 'Nao Existe'],
      kanban_actions: [{ action: 'create_kanban_card', crm_id: board.id, crm_column_id: column.id, value: '{pedido.valor}' }],
      trigger_flow: true,
      flow_id: flowId,
      connection_value: '{instancia.numero}',
    })
    const body = lead({ instancia: { numero: '5511 3333-4444' }, pedido: { valor: '199,90' } })
    const r = await processor().process(await receive(co, hook.id, body))
    expect(r.steps.map((s) => s.step)).toEqual(['resolve_customer', 'identity_fields', 'custom_fields', 'resolve_connection', 'tags', 'kanban', 'trigger_flow'])
    expect(r.steps).toEqual([
      { step: 'resolve_customer', status: 'ok' },
      { step: 'identity_fields', status: 'skipped', reason: 'unchanged' },
      { step: 'custom_fields', status: 'ok' },
      { step: 'resolve_connection', status: 'ok' },
      { step: 'tags', status: 'failed', reason: 'labels_not_found:Nao Existe' },
      { step: 'kanban', status: 'ok' },
      { step: 'trigger_flow', status: 'ok' },
    ])
    const req = await request((await db.select().from(inboundWebhookRequests).where(eq(inboundWebhookRequests.webhookId, hook.id)))[0]!.id)
    expect(req).toMatchObject({ processingStatus: 'failed', error: 'step_failed', reason: 'labels_not_found:Nao Existe', processedAt: expect.any(Date) })
    const [c] = await db.select().from(contacts).where(eq(contacts.companyId, co))
    expect(c).toMatchObject({ name: 'Ana Lima', email: body.cliente.email, customFields: { cpf: '123.456.789-00' } })
    expect(c!.phoneE164!.endsWith(body.cliente.fone)).toBe(true)
    expect((await db.select().from(kanbanCards).where(eq(kanbanCards.crmId, board.id)))[0]).toMatchObject({ columnId: column.id })
    const [run] = await db.select().from(flowRuns).where(eq(flowRuns.contactId, c!.id))
    expect(run).toMatchObject({ flowId, trigger: expect.objectContaining({ type: 'inbound_webhook', webhook_id: hook.id }) })
    expect(conn).toBeTruthy()

    // Mesmo telefone, nome novo: atualiza a identidade; o run anterior é cancelado e um novo começa.
    const again = await processor().process(await receive(co, hook.id, { ...body, cliente: { ...body.cliente, nome: 'Ana L. Lima' } }))
    expect(again.steps[1]).toEqual({ step: 'identity_fields', status: 'ok' })
    const runs = await db.select().from(flowRuns).where(eq(flowRuns.contactId, c!.id))
    expect(runs.map((x) => x.status).sort()).toEqual(['cancelled', 'running'])
  })

  it('missing_required_fields, conflito de unicidade e webhook inativo', async () => {
    const co = await company()
    const hook = await webhook(co, { field_paths: { full_name: path('cliente.nome'), phone: path('cliente.fone'), email: path('cliente.email') } })
    const r = await processor().process(await receive(co, hook.id, { cliente: { nome: 'Sem fone' } }))
    expect(r).toMatchObject({ status: 'failed', error: 'missing_required_fields', steps: [{ step: 'resolve_customer', status: 'failed', reason: 'missing_required_fields' }, expect.objectContaining({ step: 'identity_fields', reason: 'customer_not_resolved' }), ...Array(5).fill(expect.anything())] })

    // E-mail de outro contato num contato existente → unique_constraint.
    await db.insert(contacts).values({ companyId: co, name: 'Outro', phoneE164: '+5511900000001', email: 'dono@x.com' })
    await db.insert(contacts).values({ companyId: co, name: 'Bia', phoneE164: '+5511900000002' })
    const conflict = await processor().process(await receive(co, hook.id, { cliente: { nome: 'Bia', fone: '+5511900000002', email: 'dono@x.com' } }))
    expect(conflict.status).toBe('failed')
    expect(conflict.steps.find((s) => s.status === 'failed')).toMatchObject({ reason: 'unique_constraint' })

    await db.execute(sql`update crm.inbound_webhooks set active = false where id = ${hook.id}`)
    const job = await receive(co, hook.id, { cliente: { nome: 'X', fone: '+5511900000003' } })
    // A recepção grava inativo como skipped; o processador também respeita se ficou inativo depois.
    await db.execute(sql`update crm.inbound_webhook_requests set processing_status = 'pending', error = null where id = ${job.requestId}`)
    expect(await processor().process(job)).toMatchObject({ status: 'skipped', error: 'webhook_inactive' })
  })

  it('AC-T81-02: corpo repetido em 10 min → skipped duplicate_payload; fora da janela processa; condições não satisfeitas não disparam', async () => {
    const co = await company()
    await connection(co, '+55 11 98888-7777')
    const flowId = await publishedFlow(co)
    const hook = await webhook(co, {
      field_paths: { full_name: path('cliente.nome'), phone: path('cliente.fone') },
      trigger_flow: true,
      flow_id: flowId,
      connection_value: '11988887777',
      trigger_conditions: { ruleType: 'all', conditions: [{ category: 'field', fieldName: 'name', fieldOperator: 'contains', fieldValue: 'vip' }, { category: 'system', systemSubtype: 'tag', systemOperator: 'different', tagName: 'bloqueado' }] },
    })
    const body = { cliente: { nome: 'Carlos', fone: '+5511977776666' } }
    const t0 = new Date('2026-10-16T10:00:00Z')
    const first = await receive(co, hook.id, body, t0)
    const dup = await receive(co, hook.id, body, new Date(t0.getTime() + 9 * 60_000))
    const late = await receive(co, hook.id, body, new Date(t0.getTime() + 25 * 60_000))
    const p = processor()
    const r1 = await p.process(first)
    expect(r1).toMatchObject({ status: 'processed', reason: 'conditions_not_met' })
    expect(r1.steps.at(-1)).toEqual({ step: 'trigger_flow', status: 'skipped', reason: 'conditions_not_met' })
    expect(await p.process(dup)).toMatchObject({ status: 'skipped', error: 'duplicate_payload', reason: 'duplicate_payload', steps: [] })
    expect((await p.process(late)).status).toBe('processed')
    // Idempotente: reprocessar não faz nada.
    expect((await p.process(first)).status).toBe('noop')
    const [c] = await db.select().from(contacts).where(eq(contacts.companyId, co))
    expect(await db.select().from(flowRuns).where(eq(flowRuns.contactId, c!.id))).toHaveLength(0)

    // `any` satisfeita (nome contém 'car') dispara.
    const anyHook = await webhook(co, {
      field_paths: { full_name: path('cliente.nome'), phone: path('cliente.fone') },
      trigger_flow: true,
      flow_id: flowId,
      connection_value: '11988887777',
      trigger_conditions: { ruleType: 'any', conditions: [{ category: 'field', fieldName: 'name', fieldOperator: 'contains', fieldValue: 'CAR' }, { category: 'field', fieldName: 'email', fieldOperator: 'has_value' }] },
    })
    expect((await processor().process(await receive(co, anyHook.id, { ...body, n: 2 }))).steps.at(-1)).toEqual({ step: 'trigger_flow', status: 'ok' })
  })

  it('AC-T81-03: conexão pelos 8 últimos dígitos; ambígua, inexistente, curta ou desconectada não dispara e registra o motivo', async () => {
    const co = await company()
    await connection(co, '+55 11 2222-1111')
    await connection(co, '+55 21 2222-1111')
    await connection(co, '+55 31 5555-0000', 'close')
    const flowId = await publishedFlow(co)
    const run = async (connectionValue: string) => {
      const hook = await webhook(co, { field_paths: { full_name: path('n'), phone: path('f') }, trigger_flow: true, flow_id: flowId, connection_value: connectionValue })
      return processor().process(await receive(co, hook.id, { n: 'Dora', f: `+5511966${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`, num: '(31) 5555-0000' }))
    }
    const step = (r: Awaited<ReturnType<typeof run>>, name: string) => r.steps.find((s) => s.step === name)
    expect(step(await run('22221111'), 'resolve_connection')).toEqual({ step: 'resolve_connection', status: 'skipped', reason: 'connection_not_resolved:ambiguous' })
    expect(step(await run('99998888'), 'resolve_connection')).toMatchObject({ reason: 'connection_not_resolved:not_found' })
    expect(step(await run('1234'), 'resolve_connection')).toMatchObject({ reason: 'connection_not_resolved:too_short' })
    expect(step(await run('{nao.existe}'), 'resolve_connection')).toMatchObject({ reason: expect.stringMatching(/^connection_not_resolved/) })
    const disc = await run('{num}')
    expect(step(disc, 'resolve_connection')).toEqual({ step: 'resolve_connection', status: 'ok' })
    expect(step(disc, 'trigger_flow')).toEqual({ step: 'trigger_flow', status: 'skipped', reason: 'skipped_due_to_disconnected_connection' })
    expect(disc.status).toBe('processed')
    const noConn = await processor().process(await receive(co, (await webhook(co, { field_paths: { full_name: path('n'), phone: path('f') } })).id, { n: 'Eva', f: '+5511955554444' }))
    expect(noConn.steps.find((s) => s.step === 'resolve_connection')).toEqual({ step: 'resolve_connection', status: 'skipped', reason: 'no_connection' })
    expect(await db.select().from(flowRuns).where(eq(flowRuns.companyId, co))).toHaveLength(0)
  })

  it('AC-T81-04: amostra só para quem escuta aquele webhook, uma vez; varredura reenfileira pending', async () => {
    const co = await company()
    const a = await webhook(co, { field_paths: { full_name: path('n'), phone: path('f') } })
    const b = await webhook(co, { field_paths: { full_name: path('n'), phone: path('f') } })
    const listeners = new SampleListeners(redis)
    const userA = '00000000-0000-4000-8000-00000000000a'
    const userB = '00000000-0000-4000-8000-00000000000b'
    await listeners.listen(a.id, userA)
    await listeners.listen(b.id, userB)
    published.length = 0
    const job = await receive(co, a.id, { n: 'Gil', f: '+5511944443333' })
    await processor().process(job)
    const samples = published.filter((p) => p.type === 'webhook.sample_received')
    expect(samples).toEqual([
      { companyId: co, type: 'webhook.sample_received', data: { webhook_id: a.id, request_id: job.requestId, request: { raw_body: JSON.stringify({ n: 'Gil', f: '+5511944443333' }), raw_body_truncated: false } }, opts: { userId: userA } },
    ])
    published.length = 0
    await processor().process(await receive(co, a.id, { n: 'Gil 2', f: '+5511944443333' }))
    expect(published.filter((p) => p.type === 'webhook.sample_received')).toHaveLength(0)

    const pending = await receive(co, b.id, { n: 'Hugo', f: '+5511933332222' }, new Date(Date.now() - 5 * 60_000))
    const queued: unknown[] = []
    const n = await processor().sweepPending({ olderThanMs: 60_000 }, async (d, o) => void queued.push({ d, o }))
    expect(n).toBeGreaterThanOrEqual(1)
    expect(queued).toContainEqual({ d: pending, o: { jobId: `iwr-${pending.requestId}` } })
  })
})

describe('consentimento do contato criado pelo webhook (T127)', () => {
  it("contato novo: consent_source 'webhook' no CRM e recordConsent 'webhook' no gateway; contato existente não repassa de novo", async () => {
    const co = await company()
    const hook = await webhook(co, { field_paths: { full_name: path('n'), phone: path('f') } })
    const consents: unknown[] = []
    const waGateway = { recordConsent: async (input: unknown) => void consents.push(input) }
    const p = new InboundWebhookProcessor({ db, waGateway, publisher: publisher as never })
    const r = await p.process(await receive(co, hook.id, { n: 'Ivo Lima', f: '+5511922221111' }))
    expect(r.status).toBe('processed')
    const [c] = await db.select().from(contacts).where(eq(contacts.companyId, co))
    expect(c).toMatchObject({ phoneE164: '+5511922221111', consent: true, consentSource: 'webhook', origin: 'webhook' })
    expect(consents).toEqual([{ phone: '+5511922221111', source: 'webhook', name: 'Ivo Lima' }])

    await p.process(await receive(co, hook.id, { n: 'Ivo Lima', f: '+5511922221111', x: 1 }))
    expect(consents).toHaveLength(1)
  })
})
