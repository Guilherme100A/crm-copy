// Postgres real + motor (T25): distribuidor com contadores e prevenção de repetição, conexão de fluxo (ativo vs.
// inativo) e intervalo inteligente gravando a espera `timer`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { createNodeRegistry } from '../../engine/registry'
import { FlowEngine } from '../../engine/runner'
import { FlowStore } from '../../store/store'
import { registerLogicNodes } from './index'

let tmp: TempDatabase
let db: Database
let store: FlowStore
let n = 0
const NOW = new Date('2026-10-19T13:30:00Z')
const published: Array<{ type: string; data: { outputs: Array<{ id: string; count: number }> } }> = []

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
const action = (id: string, type: string, config: unknown) => ({ id, type, order: 0, config })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const marker = (id: string) => node(id, 'smart_interval', [action(`${id}-a`, 'smart_interval', { schedule_type: 'time', interval_value: 1, interval_unit: 'minutes' })])

async function company() {
  n += 1
  return (await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t41-${n}-${Date.now()}`}) returning id`)).id
}
async function contact(co: string) {
  n += 1
  return (await one<{ id: string }>(sql`insert into crm.contacts (company_id, name, phone_e164) values (${co}, 'C', ${`+5511900${String(n).padStart(6, '0')}`}) returning id`)).id
}
async function flowOf(co: string, def: unknown, status: 'active' | 'paused' = 'active') {
  const flow = await store.createFlow({ companyId: co }, { name: `F${n++}` })
  await store.fromDefinition({ companyId: co }, flow.id, def)
  await store.publish({ companyId: co }, flow.id)
  await store.updateFlow({ companyId: co }, flow.id, { status })
  return flow.id
}
const def = (nodes: unknown[], edges: unknown[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })

function engine() {
  const registry = registerLogicNodes(createNodeRegistry(), {
    now: () => NOW,
    publisher: { publish: async (_c, type, data) => void published.push({ type, data: data as never }) },
    timeZone: async () => 'America/Sao_Paulo',
  })
  return new FlowEngine({ db, wa: new FakeWaGateway(), registry })
}
async function run(co: string, flowId: string, contactId: string) {
  const e = engine()
  const { runId } = await e.startRun({ companyId: co }, { flowId, contactId })
  await e.step(runId, 0)
  return one<{ id: string; status: string; current_node_key: string | null; error: string | null; wait: { deadline_at: string } | null }>(
    sql`select id, status, current_node_key, error, wait from crm.flow_runs where id = ${runId}`,
  )
}

describe('distribuidor', () => {
  it('quantidades 2:1, contadores e evento; prevenção de repetição devolve a mesma saída', async () => {
    const co = await company()
    const d = def(
      [node('D', 'distributor', [action('D-a', 'distribute_contacts', { outputs: [{ id: 'a', quantity: 2 }, { id: 'b', quantity: 1 }], prevent_repetition: true })]), marker('A'), marker('B')],
      [edge('start', 'source', 'D'), edge('D', 'output:a', 'A'), edge('D', 'output:b', 'B')],
    )
    const flowId = await flowOf(co, d)
    const contacts = [await contact(co), await contact(co), await contact(co)]
    const landed: string[] = []
    for (const c of contacts) landed.push((await run(co, flowId, c)).current_node_key!)
    expect(landed).toEqual(['A', 'A', 'B'])
    const counters = (await db.execute(sql`select output_key, count from crm.flow_distributor_counters where flow_id = ${flowId} order by output_key`)).rows
    expect(counters).toEqual([
      { output_key: 'a', count: 2 },
      { output_key: 'b', count: 1 },
    ])
    expect(published.at(-1)).toMatchObject({ type: 'flow.distributor_updated', data: { outputs: [{ id: 'a', count: 2 }, { id: 'b', count: 1 }] } })

    // O 3º contato (que foi para B) volta: mesma saída, sem incrementar.
    await db.execute(sql`update crm.flow_runs set status = 'completed' where contact_id = ${contacts[2]}`)
    expect((await run(co, flowId, contacts[2]!)).current_node_key).toBe('B')
    expect((await one<{ count: number }>(sql`select count from crm.flow_distributor_counters where flow_id = ${flowId} and output_key = 'b'`)).count).toBe(1)
  })
})

describe('conexão de fluxo', () => {
  it('destino ativo: run atual completed e novo run no destino; inativo: failed com target_flow_inactive', async () => {
    const co = await company()
    const target = await flowOf(co, def([marker('T')], [edge('start', 'source', 'T')]))
    const paused = await flowOf(co, def([marker('P')], [edge('start', 'source', 'P')]), 'paused')
    const jump = (to: string) => def([node('J', 'connection_flow', [action('J-a', 'execute_flow', { target_flow_id: to })])], [edge('start', 'source', 'J')])
    const c1 = await contact(co)
    const first = await run(co, await flowOf(co, jump(target)), c1)
    expect(first.status).toBe('completed')
    const next = await one<{ flow_id: string; trigger: { kind: string; from_run_id: string } }>(sql`select flow_id, trigger from crm.flow_runs where contact_id = ${c1} and id <> ${first.id}`)
    expect(next).toMatchObject({ flow_id: target, trigger: { kind: 'connection_flow', from_run_id: first.id } })

    const bad = await run(co, await flowOf(co, jump(paused)), await contact(co))
    expect(bad.status).toBe('failed')
    expect(bad.error).toMatch(/^target_flow_inactive/)
  })
})

describe('intervalo inteligente', () => {
  it('grava a espera timer com o próximo instante no fuso', async () => {
    const co = await company()
    const d = def(
      [node('I', 'smart_interval', [action('I-a', 'smart_interval', { schedule_type: 'date', scheduled_date: '2026-10-20T09:00' })]), marker('X')],
      [edge('start', 'source', 'I'), edge('I', 'source', 'X')],
    )
    const r = await run(co, await flowOf(co, d), await contact(co))
    expect(r.status).toBe('waiting')
    expect(r.wait?.deadline_at).toBe('2026-10-20T12:00:00.000Z')
  })
})
