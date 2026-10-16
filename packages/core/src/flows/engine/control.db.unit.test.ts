// Postgres real: corrida resposta × timer, cancelamento e pausa/retomada com o restante do prazo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, flowRuns, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq } from 'drizzle-orm'
import { FlowStore } from '../store/store'
import { FlowControl } from './control'
import { createNodeRegistry } from './registry'
import { FlowEngine, type FlowStepJobData } from './runner'
import type { FlowTimerJobData, TimerScheduler } from './timers'
import { waitForReply } from './waits'

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

/** start → w (espera de 10 min) → reply: r | timeout: t */
async function setup(clock: { t: Date }) {
  n += 1
  const [c] = await db.insert(companies).values({ name: `C${n}`, slug: `c-t30-${n}-${Date.now()}` }).returning()
  const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: `+55119888${String(n).padStart(5, '0')}` }).returning()
  const ctx = { companyId: c!.id }
  const store = new FlowStore(db)
  const flow = await store.createFlow(ctx, { name: `F${n}` })
  const def: FlowDefinition = {
    schema: 'crm.flow/v1',
    entry: 'start',
    nodes: [node('start', 'start'), node('w', 'wait_response'), node('r', 'message'), node('t', 'message')],
    edges: [edge('start', 'source', 'w'), edge('w', 'source', 'r'), edge('w', 'timeout', 't')],
    variables: [],
    refs: {},
  }
  await store.fromDefinition(ctx, flow.id, def)
  await store.publish(ctx, flow.id)
  const scheduled: Array<{ data: FlowTimerJobData; delayMs: number }> = []
  const cancelled: FlowTimerJobData[] = []
  const timers: TimerScheduler = {
    schedule: async (data, delayMs) => void scheduled.push({ data, delayMs }),
    cancel: async (data) => void cancelled.push(data),
  }
  const steps: FlowStepJobData[] = []
  const now = () => clock.t
  const control = new FlowControl({ db, timers, now, shortDelayMs: 0, enqueueStep: async (j) => void steps.push(j) })
  const registry = createNodeRegistry()
    .register('wait_response', { execute: () => ({ wait: waitForReply({ delayMs: 10 * 60_000 }) }) })
    .register('message', { execute: (ctx) => (ctx.setVar('passou', ctx.node.id), { end: true }) })
  const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry, hooks: control.engineHooks(), now })
  const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: contact!.id })
  await engine.step(runId, 0)
  return { ctx, flowId: flow.id, contactId: contact!.id, runId, control, engine, scheduled, cancelled, steps }
}

const runOf = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!

describe('FlowControl', () => {
  it('espera agenda o timer com o atraso exato; resposta e timer simultâneos → só um avança', async () => {
    const clock = { t: new Date('2026-10-16T12:00:00Z') }
    const s = await setup(clock)
    expect((await runOf(s.runId)).status).toBe('waiting')
    expect(s.scheduled).toEqual([{ data: { runId: s.runId, seq: 2, gen: 0 }, delayMs: 600_000 }])
    const [a, b] = await Promise.all([s.control.resolveReply(s.runId, { text: 'oi' }), s.control.fireTimer({ runId: s.runId, seq: 2, gen: 0 })])
    expect([a, b].filter((r) => r.advanced)).toHaveLength(1)
    const loser = [a, b].find((r) => !r.advanced)!
    expect(['not_waiting', 'stale']).toContain((loser as { reason: string }).reason)
    expect(s.steps).toEqual([{ runId: s.runId, expectedSeq: 3 }])
    await s.engine.step(s.runId, 3)
    const run = await runOf(s.runId)
    expect(run.status).toBe('completed')
    expect(run.vars).toMatchObject({ passou: a.advanced ? 'r' : 't', ...(a.advanced ? { last_user_message: 'oi' } : {}) })
  })

  it('cancel deixa cancelled, remove o timer e o disparo antigo é no-op', async () => {
    const clock = { t: new Date('2026-10-16T12:00:00Z') }
    const s = await setup(clock)
    expect(await s.control.cancel(s.runId)).toEqual({ cancelled: true })
    expect(s.cancelled).toEqual([{ runId: s.runId, seq: 2, gen: 0 }])
    expect((await runOf(s.runId)).status).toBe('cancelled')
    expect(await s.control.fireTimer({ runId: s.runId, seq: 2 })).toEqual({ advanced: false, reason: 'cancelled' })
    expect(await s.control.cancel(s.runId)).toEqual({ cancelled: false })
  })

  it('pausa congela com o restante; retomar reagenda o restante com gen+1; timer da geração antiga é stale', async () => {
    const clock = { t: new Date('2026-10-16T12:00:00Z') }
    const s = await setup(clock)
    clock.t = new Date('2026-10-16T12:04:00Z')
    expect(await s.control.pauseFlow(s.ctx, s.flowId)).toEqual({ paused_runs: 1 })
    expect((await db.select().from(flows).where(eq(flows.id, s.flowId)))[0]!.status).toBe('paused')
    expect(await s.control.fireTimer({ runId: s.runId, seq: 2, gen: 0 })).toEqual({ advanced: false, reason: 'paused' })
    expect(await s.control.resolveReply(s.runId, { text: 'x' })).toEqual({ advanced: false, reason: 'paused' })

    clock.t = new Date('2026-10-16T12:30:00Z')
    expect(await s.control.resumeFlow(s.ctx, s.flowId)).toEqual({ resumed_runs: 1 })
    const run = await runOf(s.runId)
    expect(run.status).toBe('waiting')
    expect(new Date((run.wait as { deadline_at: string }).deadline_at).getTime() - clock.t.getTime()).toBe(6 * 60_000)
    expect(s.scheduled.at(-1)).toEqual({ data: { runId: s.runId, seq: 2, gen: 1 }, delayMs: 6 * 60_000 })
    expect(await s.control.fireTimer({ runId: s.runId, seq: 2, gen: 0 })).toEqual({ advanced: false, reason: 'stale' })
    expect(await s.control.fireTimer({ runId: s.runId, seq: 2, gen: 1 })).toMatchObject({ advanced: true, handle: 'timeout' })
  })

  it('resposta pelo contato acha o run em espera; sem run → not_found', async () => {
    const clock = { t: new Date('2026-10-16T12:00:00Z') }
    const s = await setup(clock)
    expect(await s.control.resolveReplyForContact(s.ctx, s.contactId, { text: 'sim' })).toMatchObject({ advanced: true, handle: 'source' })
    expect(await s.control.resolveReplyForContact(s.ctx, s.contactId, { text: 'de novo' })).toEqual({ advanced: false, reason: 'not_found' })
    expect(s.cancelled).toEqual([{ runId: s.runId, seq: 2, gen: 0 }])
  })
})
