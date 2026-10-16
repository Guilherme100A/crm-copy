// Nó pixel no motor real (T25) contra o FakeMetaGraph (AC-T104-03, 04): valor com variável, moeda inválida → BRL,
// saídas success/failure/source e falha sem aresta failure que só segue.
import { randomBytes } from 'node:crypto'
import { capiEventLog, createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { generateCredentialsKey, initCredentialsCrypto } from '@crm/node-kit'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeMetaGraph } from '../../../meta-ads/client/testing'
import { PixelConfigService } from '../../../meta-capi/pixels'
import { createNodeRegistry } from '../../engine/registry'
import { FlowEngine } from '../../engine/runner'
import { FlowStore } from '../../store/store'
import { registerPixelNodes } from './index'

let tmp: TempDatabase
let db: Database
let store: FlowStore
const fake = new FakeMetaGraph()

beforeAll(async () => {
  initCredentialsCrypto({ key: generateCredentialsKey() })
  await fake.start()
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  store = new FlowStore(db)
}, 120_000)
afterAll(async () => {
  await fake.close()
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T
const node = (id: string, type: string, actions: unknown[] = []) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions })
const action = (id: string, type: string, config: unknown, order = 0) => ({ id, type, order, config })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const def = (nodes: unknown[], edges: unknown[]) => ({ schema: 'crm.flow/v1', entry: 'start', nodes: [node('start', 'start'), ...nodes], edges, variables: [], refs: {} })
const pixelNode = (config: Record<string, unknown>) => node('P', 'pixel', [action('a', 'send_pixel_event', config)])
const marker = (id: string) => node(id, 'tags', [action(`t-${id}`, 'add_tags', { tags: [id] })])

async function world() {
  const tag = randomBytes(4).toString('hex')
  const co = (await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${tag}`}, ${`c-t104-${tag}`}) returning id`)).id
  const contact = (await one<{ id: string }>(sql`insert into crm.contacts (company_id, name, phone_e164) values (${co}, 'Maria', ${`+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`}) returning id`)).id
  const pixelId = String(200000000000000 + Math.floor(Math.random() * 1e9))
  const token = `EAAB${randomBytes(12).toString('hex')}`
  fake.addPixel(pixelId, token)
  const pixel = await new PixelConfigService({ db }).create(co, { name: 'Pixel', pixel_id: pixelId, access_token: token })
  return { co, contact, pixelId, pixelConfigId: pixel.id }
}

async function run(co: string, contactId: string, d: unknown, vars: Record<string, unknown> = {}) {
  const flow = await store.createFlow({ companyId: co }, { name: `F${randomBytes(3).toString('hex')}` })
  await store.fromDefinition({ companyId: co }, flow.id, d)
  await store.publish({ companyId: co }, flow.id)
  const visited: string[] = []
  const registry = registerPixelNodes(createNodeRegistry(), { graphUrl: fake.url, testEventCode: null }).register('tags', {
    execute: (ctx) => (visited.push(ctx.node.id), { end: true }),
  })
  const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry })
  const { runId } = await engine.startRun({ companyId: co }, { flowId: flow.id, contactId, vars })
  await engine.step(runId, 0)
  const r = await one<{ status: string; error: string | null }>(sql`select status, error from crm.flow_runs where id = ${runId}`)
  return { ...r, runId, visited }
}

describe('nó pixel', () => {
  it('envia Compra com valor de variável e moeda inválida → BRL; segue success (AC-T104-03/04)', async () => {
    const w = await world()
    const d = def(
      [pixelNode({ pixel_config_id: w.pixelConfigId, event_type: 'Compra', item_value: '{preco}', currency: 'reais', page_id: '123' }), marker('OK'), marker('ERR')],
      [edge('start', 'source', 'P'), edge('P', 'success', 'OK'), edge('P', 'failure', 'ERR')],
    )
    const r = await run(w.co, w.contact, d, { preco: '149,90' })
    expect(r).toMatchObject({ status: 'completed', visited: ['OK'] })
    const evs = fake.capiEventsFor(w.pixelId)
    expect(evs).toHaveLength(1)
    expect(evs[0]!.event).toMatchObject({ event_name: 'Purchase', action_source: 'chat', custom_data: { currency: 'BRL', value: 149.9 } })
    expect(JSON.stringify(evs[0]!.event)).not.toContain('page_id')
    expect((evs[0]!.event.user_data as Record<string, unknown>).ph).toHaveLength(1)
    const [log] = await db.select().from(capiEventLog).where(eq(capiEventLog.pixelConfigId, w.pixelConfigId))
    expect(log).toMatchObject({ status: 'sent', source: 'flow', sourceId: r.runId })
  })

  it('falha da Meta segue failure', async () => {
    const w = await world()
    const d = def(
      [pixelNode({ pixel_config_id: w.pixelConfigId, event_type: 'Lead' }), marker('OK'), marker('ERR')],
      [edge('start', 'source', 'P'), edge('P', 'success', 'OK'), edge('P', 'failure', 'ERR')],
    )
    fake.failNext(500, { message: 'meta fora', code: 1 })
    const r = await run(w.co, w.contact, d)
    expect(r).toMatchObject({ status: 'completed', visited: ['ERR'] })
    const step = await one<{ status: string; result: { handle?: string } }>(sql`select status, result from crm.flow_run_steps where run_id = ${r.runId} and node_key = 'P' and action_key is null`)
    expect(step).toMatchObject({ status: 'failed', result: { handle: 'failure' } })
  })

  it('fluxo antigo só com source: sucesso segue source; falha sem aresta failure só loga e segue', async () => {
    const w = await world()
    const d = (pixelConfigId: string) => def([pixelNode({ pixel_config_id: pixelConfigId, event_type: 'Lead' }), marker('N')], [edge('start', 'source', 'P'), edge('P', 'source', 'N')])
    expect(await run(w.co, w.contact, d(w.pixelConfigId))).toMatchObject({ status: 'completed', visited: ['N'] })
    // Pixel inexistente (uuid válido de outra coisa) sem aresta failure: o fluxo continua.
    expect(await run(w.co, w.contact, d('00000000-0000-4000-8000-000000000000'))).toMatchObject({ status: 'completed', visited: ['N'] })
  })
})
