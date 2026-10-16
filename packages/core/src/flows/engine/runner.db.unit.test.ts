// Postgres real (SPEC 3.10): concorrência do mesmo passo, crash depois do envio e registro dos passos.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, flowRunSteps, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, isNotNull, isNull, and } from 'drizzle-orm'
import { FlowStore } from '../store/store'
import type { NodeHandler } from './context'
import { createNodeRegistry } from './registry'
import { FlowEngine, FlowEngineError } from './runner'

let tmp: TempDatabase
let db: Database
let n = 0

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 10 })
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })

async function setup(nodes: ReturnType<typeof node>[], edges: ReturnType<typeof edge>[]) {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-${n}-${Date.now()}` }).returning()
  const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: `+55119999${String(n).padStart(5, '0')}` }).returning()
  const ctx = { companyId: c!.id }
  const store = new FlowStore(db)
  const flow = await store.createFlow(ctx, { name: `F${n}` })
  const definition: FlowDefinition = { schema: 'crm.flow/v1', entry: 'start', nodes, edges, variables: [], refs: {} }
  await store.fromDefinition(ctx, flow.id, definition)
  await store.publish(ctx, flow.id)
  return { ctx, flowId: flow.id, contactId: contact!.id }
}

const nodeRows = (runId: string) => db.select().from(flowRunSteps).where(and(eq(flowRunSteps.runId, runId), isNull(flowRunSteps.actionKey)))
const runOf = async (runId: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, runId)))[0]!

describe('FlowEngine (Postgres)', () => {
  it('start → A → B: uma linha por nó e completed; contato com run ativo é recusado', async () => {
    const s = await setup([node('start', 'start'), node('a', 'message'), node('b', 'message')], [edge('start', 'source', 'a'), edge('a', 'source', 'b')])
    const gw = new FakeWaGateway()
    const engine = new FlowEngine({ db, wa: gw, registry: createNodeRegistry().register('message', { execute: () => ({ next: 'source' }) }) })
    const { runId } = await engine.startRun(s.ctx, { flowId: s.flowId, contactId: s.contactId })
    await expect(engine.startRun(s.ctx, { flowId: s.flowId, contactId: s.contactId })).rejects.toMatchObject({ code: 'run_active' })
    expect(await engine.step(runId, 0)).toMatchObject({ executed: true, status: 'completed', seq: 3, steps: 3 })
    expect((await nodeRows(runId)).map((r) => r.nodeKey)).toEqual(expect.arrayContaining(['start', 'a', 'b']))
    expect((await runOf(runId)).finishedAt).not.toBeNull()
    expect(await engine.step(runId, 0)).toEqual({ executed: false, reason: 'not_running' })
  })

  it('dois workers no mesmo passo: um executa, o outro é no-op', async () => {
    const s = await setup([node('start', 'start'), node('a', 'message')], [edge('start', 'source', 'a')])
    let calls = 0
    const slow: NodeHandler = {
      execute: async () => {
        calls += 1
        await new Promise((r) => setTimeout(r, 200))
        return { end: true }
      },
    }
    const registry = createNodeRegistry().register('message', slow)
    const gw = new FakeWaGateway()
    const e1 = new FlowEngine({ db, wa: gw, registry })
    const e2 = new FlowEngine({ db, wa: gw, registry })
    const { runId } = await e1.startRun(s.ctx, { flowId: s.flowId, contactId: s.contactId })
    const results = await Promise.all([e1.step(runId, 0), e2.step(runId, 0)])
    expect(calls).toBe(1)
    expect(results.filter((r) => r.executed)).toHaveLength(1)
  })

  it('crash depois do envio: o retry do mesmo passo não reenvia', async () => {
    const s = await setup([node('start', 'start'), node('a', 'message')], [edge('start', 'source', 'a')])
    const gw = new FakeWaGateway({ sessions: [{ id: 'sess' }] })
    const send: NodeHandler = {
      async execute(ctx) {
        await ctx.wa.send({ sessionId: 'sess', phone: '+5511999990000', content: { kind: 'text', text: 'oi' } as never, actor: 'crm:t' }, { actionId: 'a1' })
        return { end: true }
      },
    }
    let crash = true
    const engine = new FlowEngine({
      db,
      wa: gw,
      registry: createNodeRegistry().register('message', send),
      hooks: {
        afterNode: (info) => {
          if (crash && info.nodeKey === 'a') {
            crash = false
            throw new Error('crash')
          }
        },
      },
    })
    const { runId } = await engine.startRun(s.ctx, { flowId: s.flowId, contactId: s.contactId })
    await expect(engine.step(runId, 0)).rejects.toThrow('crash')
    expect((await runOf(runId)).seq).toBe(0)
    expect(await engine.step(runId, 0)).toMatchObject({ executed: true, status: 'completed' })
    expect(gw.sent).toHaveLength(1)
    const actionRows = await db.select().from(flowRunSteps).where(and(eq(flowRunSteps.runId, runId), isNotNull(flowRunSteps.actionKey)))
    expect(actionRows.map((r) => r.actionKey)).toEqual(['a1'])
  })

  it('ação sem failure: run failed com o erro gravado no run e no passo', async () => {
    const s = await setup([node('start', 'start'), node('i', 'integration')], [edge('start', 'source', 'i')])
    const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry: createNodeRegistry().register('integration', { execute: () => Promise.reject(new Error('timeout')) }) })
    const { runId } = await engine.startRun(s.ctx, { flowId: s.flowId, contactId: s.contactId })
    expect(await engine.step(runId, 0)).toMatchObject({ executed: true, status: 'failed', error: 'timeout' })
    expect((await runOf(runId)).error).toBe('timeout')
    expect((await nodeRows(runId)).find((r) => r.nodeKey === 'i')).toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('fluxo sem versão publicada e contato de outra empresa são recusados', async () => {
    const s = await setup([node('start', 'start')], [])
    const store = new FlowStore(db)
    const draft = await store.createFlow(s.ctx, { name: 'rascunho' })
    const engine = new FlowEngine({ db, wa: new FakeWaGateway() })
    await expect(engine.startRun(s.ctx, { flowId: draft.id, contactId: s.contactId })).rejects.toBeInstanceOf(FlowEngineError)
    const other = await setup([node('start', 'start')], [])
    await expect(engine.startRun(s.ctx, { flowId: s.flowId, contactId: other.contactId })).rejects.toMatchObject({ code: 'contact_not_found' })
  })

  it('jump para outro fluxo encerra este run e inicia o destino; dry-run do rascunho não grava', async () => {
    const target = await setup([node('start', 'start')], [])
    const store = new FlowStore(db)
    const src = await store.createFlow(target.ctx, { name: 'origem' })
    await store.fromDefinition(target.ctx, src.id, {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [node('start', 'start'), node('j', 'connection_flow')],
      edges: [edge('start', 'source', 'j')],
      variables: [],
      refs: {},
    })
    await store.publish(target.ctx, src.id)
    const jobs: unknown[] = []
    const engine = new FlowEngine({
      db,
      wa: new FakeWaGateway(),
      registry: createNodeRegistry().register('connection_flow', { execute: () => ({ jump: { flowId: target.flowId } }) }),
      enqueue: async (j) => void jobs.push(j),
    })
    const { runId } = await engine.startRun(target.ctx, { flowId: src.id, contactId: target.contactId })
    expect(await engine.step(runId, 0)).toMatchObject({ status: 'completed' })
    const runs = await db.select().from(flowRuns).where(eq(flowRuns.contactId, target.contactId))
    expect(runs.map((r) => [r.flowId, r.status]).sort()).toEqual([[src.id, 'completed'], [target.flowId, 'running']].sort())
    expect(jobs).toHaveLength(2)

    const before = (await db.select().from(flowRunSteps)).length
    const dry = await engine.dryRun(target.ctx, { flowId: src.id })
    expect(dry.status).toBe('completed')
    expect((await db.select().from(flowRunSteps)).length).toBe(before)
  })
})
