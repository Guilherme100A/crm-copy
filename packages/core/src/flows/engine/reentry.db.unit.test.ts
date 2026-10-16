// Postgres real: espera `reply` com `reentry` (T62) volta ao próprio nó, acumula `vars.__replies`, cancela o timer
// e enfileira o passo; sem `reentry` o comportamento da T30 não muda.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { FlowStore } from '../store/store'
import { FlowControl } from './control'
import { createNodeRegistry } from './registry'
import { FlowEngine, type FlowStepJobData } from './runner'
import type { FlowTimerJobData } from './timers'
import { waitForReply } from './waits'

let tmp: TempDatabase
let db: Database
let n = 0
beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })
const runOf = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!

/** start → w (espera com reentry; na 2ª resposta segue `source`) → r */
async function setup() {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t62r-${n}-${Date.now()}` }).returning()
  const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: `+55119777${String(n).padStart(5, '0')}` }).returning()
  const ctx = { companyId: c!.id }
  const store = new FlowStore(db)
  const flow = await store.createFlow(ctx, { name: `F${n}` })
  const def: FlowDefinition = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [node('start', 'start'), node('w', 'wait_response'), node('r', 'message')],
    edges: [edge('start', 'source', 'w'), edge('w', 'source', 'r')],
    variables: [],
    refs: {},
  }
  await store.fromDefinition(ctx, flow.id, def)
  await store.publish(ctx, flow.id)
  const cancelled: FlowTimerJobData[] = []
  const steps: FlowStepJobData[] = []
  const executions: number[] = []
  const control = new FlowControl({
    db,
    timers: { schedule: async () => undefined, cancel: async (d) => void cancelled.push(d) },
    shortDelayMs: 0,
    enqueueStep: async (j) => void steps.push(j),
  })
  const registry = createNodeRegistry()
    .register('wait_response', {
      execute: (c) => {
        const replies = (c.vars.__replies as unknown[] | undefined) ?? []
        executions.push(replies.length)
        if (replies.length >= 2) return { next: 'source' }
        return { wait: { ...waitForReply({ delayMs: 60_000 }), reentry: true } as unknown as Record<string, unknown> }
      },
    })
    .register('message', { execute: () => ({ end: true }) })
  const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry, hooks: control.engineHooks() })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: contact!.id })
  await engine.step(runId, 0)
  return { runId, control, engine, steps, cancelled, executions }
}

describe('reentry', () => {
  it('a resposta reexecuta o mesmo nó, acumula __replies e só segue quando o nó decide', async () => {
    const s = await setup()
    const waiting = await runOf(s.runId)
    expect(waiting).toMatchObject({ status: 'waiting', currentNodeKey: 'w' })

    const r1 = await s.control.resolveReply(s.runId, { text: 'um' })
    expect(r1).toMatchObject({ advanced: true, status: 'running' })
    const after1 = await runOf(s.runId)
    expect(after1).toMatchObject({ status: 'running', currentNodeKey: 'w', seq: waiting.seq + 1 })
    expect((after1.vars as Record<string, unknown>).__replies).toEqual([{ text: 'um' }])
    expect((after1.vars as Record<string, unknown>).last_user_message).toBe('um')
    expect(s.cancelled).toHaveLength(1)
    await s.engine.step(s.runId, s.steps.at(-1)!.expectedSeq)
    expect((await runOf(s.runId)).status).toBe('waiting')

    await s.control.resolveReply(s.runId, { text: 'dois' })
    await s.engine.step(s.runId, s.steps.at(-1)!.expectedSeq)
    const done = await runOf(s.runId)
    expect(done.status).toBe('completed')
    expect((done.vars as Record<string, unknown>).__replies).toEqual([{ text: 'um' }, { text: 'dois' }])
    expect(s.executions).toEqual([0, 1, 2])
  })
})
