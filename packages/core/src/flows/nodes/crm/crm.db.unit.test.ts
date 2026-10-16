// Postgres real + motor (T25): etiquetas idempotentes, divisão por zero → failure, venda aprovada com fallback,
// integrações e push uma vez.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createNodeRegistry } from '../../engine/registry'
import { FlowEngine } from '../../engine/runner'
import { FlowStore } from '../../store/store'
import { registerCrmNodes } from './index'

let tmp: TempDatabase
let db: Database
let store: FlowStore
let n = 0
const events: Array<{ type: string; data: Record<string, unknown> }> = []

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  store = new FlowStore(db)
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T
const node = (id: string, type: string, actions: unknown[] = []) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions })
const action = (id: string, type: string, config: unknown, order = 0) => ({ id, type, order, config })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const def = (nodes: unknown[], edges: unknown[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

async function world() {
  n += 1
  const co = (await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t63-${n}-${Date.now()}`}) returning id`)).id
  const contact = (await one<{ id: string }>(sql`insert into crm.contacts (company_id, name, phone_e164, custom_fields) values (${co}, 'Maria', ${`+5511955${String(n).padStart(6, '0')}`}, '{"saldo":"10"}'::jsonb) returning id`)).id
  return { co, contact }
}
async function run(co: string, contactId: string, d: unknown) {
  const flow = await store.createFlow({ companyId: co }, { name: `F${n++}` })
  await store.fromDefinition({ companyId: co }, flow.id, d)
  await store.publish({ companyId: co }, flow.id)
  const registry = registerCrmNodes(createNodeRegistry(), { publisher: { publish: async (_c, type, data) => (events.push({ type, data: data as never }), '1-0') } })
  const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry })
  const { runId } = await engine.startRun({ companyId: co }, { flowId: flow.id, contactId })
  await engine.step(runId, 0)
  return one<{ id: string; status: string; error: string | null; current_node_key: string | null }>(sql`select id, status, error, current_node_key from crm.flow_runs where id = ${runId}`)
}

describe('nós de CRM', () => {
  it('add_tags cria e é idempotente (sem novo contact.updated); remove_tags tira', async () => {
    const w = await world()
    const tags = (type: string) => def([node('T', 'tags', [action('a', type, { tags: ['VIP', 'vip', 'Novo'] })])], [edge('start', 'source', 'T')])
    events.length = 0
    expect((await run(w.co, w.contact, tags('add_tags'))).status).toBe('completed')
    expect((await run(w.co, w.contact, tags('add_tags'))).status).toBe('completed')
    expect(events.filter((e) => e.type === 'contact.updated')).toHaveLength(1)
    expect((await one<{ n: number }>(sql`select count(*)::int as n from crm.contact_labels where contact_id = ${w.contact}`)).n).toBe(2)
    await run(w.co, w.contact, def([node('T', 'tags', [action('a', 'remove_tags', { tags: ['novo'] })])], [edge('start', 'source', 'T')]))
    expect((await one<{ n: number }>(sql`select count(*)::int as n from crm.contact_labels where contact_id = ${w.contact}`)).n).toBe(1)
  })

  it('manipulador soma com vírgula; divisão por zero segue failure', async () => {
    const w = await world()
    const m = (op: string, value: string) =>
      def(
        [node('M', 'manipulator', [action('a', 'set_contact_custom_field', { field_name: 'saldo', operation: op, value_type: 'number', value })]), node('F', 'tags', [action('f', 'add_tags', { tags: ['erro'] })])],
        [edge('start', 'source', 'M'), edge('M', 'failure', 'F')],
      )
    expect((await run(w.co, w.contact, m('add', '2,5'))).status).toBe('completed')
    expect((await one<{ v: unknown }>(sql`select custom_fields -> 'saldo' as v from crm.contacts where id = ${w.contact}`)).v).toBe(12.5)
    const r = await run(w.co, w.contact, m('divide', '0'))
    expect(r.status).toBe('completed')
    expect((await one<{ n: number }>(sql`select count(*)::int as n from crm.contact_labels cl join crm.labels l on l.id = cl.label_id where cl.contact_id = ${w.contact} and l.name = 'erro'`)).n).toBe(1)
  })

  it('venda aprovada: fallback fora da faixa, integrações na venda e push uma vez', async () => {
    const w = await world()
    const p = await one<{ id: string; public_id: string }>(
      sql`insert into crm.products (company_id, name, currency, price_min_cents, price_max_cents, price_fallback_cents) values (${w.co}, 'Curso', 'BRL', 1000, 5000, 4700) returning id, public_id`,
    )
    events.length = 0
    const r = await run(
      w.co,
      w.contact,
      def(
        [
          node('V', 'approved_sale', [
            action('a', 'register_approved_sale', {
              product_public_id: p.public_id,
              amount_template: '999,00',
              currency_template: '',
              customer_name_template: '',
              note_issuer_id: 'nf-1',
              utmify_integration_id: 'utm-1',
              push_title_template: 'Venda de {produto.nome}',
              push_body_template: '{venda.cliente} pagou R$ {venda.valor}',
            }),
          ]),
        ],
        [edge('start', 'source', 'V')],
      ),
    )
    expect(r.status).toBe('completed')
    const sale = await one<Record<string, unknown>>(sql`select source, amount_cents::int as amount_cents, currency, product_id, customer_name, note_issuer_id, utmify_integration_id, external_id from crm.sales where company_id = ${w.co}`)
    expect(sale).toMatchObject({ source: 'flow', amount_cents: 4700, currency: 'BRL', product_id: p.id, customer_name: 'Maria', note_issuer_id: 'nf-1', utmify_integration_id: 'utm-1', external_id: `run-${r.id}-V` })
    expect(events.filter((e) => e.type === 'notification.created').map((e) => e.data)).toEqual([
      { title: 'Venda de Curso', body: 'Maria pagou R$ 47,00', url: null, kind: 'approved_sale', sale_id: expect.any(String) },
    ])
  })
})
