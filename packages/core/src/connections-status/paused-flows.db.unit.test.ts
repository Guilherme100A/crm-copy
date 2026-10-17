// T71: Retomar/Cancelar os runs pausados pela queda da conexão (Postgres descartável; FlowControl com timers falsos).
import { randomBytes } from 'node:crypto'
import { chats, companies, connections, contacts, createDb, flowRuns, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FlowControl } from '../flows/engine/control'
import type { FlowTimerJobData } from '../flows/engine/timers'
import { ConnectionPausedFlows, pausedFlowCountsByConnection } from './paused-flows'
import { ConnectionStatusProjector } from './projector'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

const rnd = () => randomBytes(4).toString('hex')
type Pub = { companyId: string; type: string; data: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

async function world() {
  const tag = rnd()
  const [co] = await db.insert(companies).values({ name: `Loja ${tag}`, slug: `t71-${tag}` }).returning()
  const sessionId = `s-${tag}`
  const [conn] = await db.insert(connections).values({ companyId: co!.id, sessionId, name: 'Vendas', connectionState: 'open' }).returning()
  const [other] = await db.insert(connections).values({ companyId: co!.id, sessionId: `o-${tag}`, name: 'Outra', connectionState: 'open' }).returning()
  let nowMs = Date.parse('2026-10-16T12:00:00.000Z')
  const now = () => new Date(nowMs)
  const scheduled: Array<{ data: FlowTimerJobData; delayMs: number }> = []
  const removed: FlowTimerJobData[] = []
  const control = new FlowControl({
    db,
    now,
    shortDelayMs: -1,
    timers: { schedule: async (data, delayMs) => void scheduled.push({ data, delayMs }), cancel: async (data) => void removed.push(data) },
  })
  const published: Pub[] = []
  const publisher = { publish: async (companyId: string, type: string, data: Record<string, unknown>) => void published.push({ companyId, type, data }) }
  const svc = new ConnectionPausedFlows({ db, control, publisher, now })
  const projector = new ConnectionStatusProjector({ db, publisher, now })
  const run = async (connectionId = conn!.id, deadline: string | null = '2026-10-16T12:10:00.000Z') => {
    const [flow] = await db.insert(flows).values({ companyId: co!.id, name: `Fluxo ${rnd()}` }).returning()
    const [ct] = await db.insert(contacts).values({ companyId: co!.id, name: 'C', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
    const [chat] = await db.insert(chats).values({ companyId: co!.id, contactId: ct!.id, connectionId }).returning()
    const [r] = await db
      .insert(flowRuns)
      .values({ companyId: co!.id, flowId: flow!.id, contactId: ct!.id, chatId: chat!.id, status: 'waiting', wait: { kind: 'reply', handles: {}, deadline_at: deadline, timer_gen: 0 } })
      .returning()
    return r!.id
  }
  const drop = () => projector.handle({ v: 1, type: 'session.connection', session_id: sessionId, at: now().toISOString(), state: 'close', reason: 'transient' })
  const runRow = async (id: string) => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!
  return { companyId: co!.id, connectionId: conn!.id, otherId: other!.id, sessionId, svc, run, drop, runRow, scheduled, removed, published, advance: (ms: number) => (nowMs += ms) }
}

describe('AC-T71-04 fluxos pausados na queda', () => {
  it('conta por conexão e só os pausados pela queda dela', async () => {
    const w = await world()
    await w.run()
    await w.run()
    await w.run(w.otherId)
    await w.drop()
    expect(await w.svc.summary(w.companyId, w.connectionId)).toEqual({ paused_count: 2, total_leads: 2 })
    const map = await pausedFlowCountsByConnection(db, w.companyId)
    expect(map.get(w.connectionId)).toBe(2)
    expect(map.get(w.otherId)).toBeUndefined()
  })

  it('Retomar: volta a waiting com prazo = agora + restante, timer_gen + 1, timer agendado e flow.resumed', async () => {
    const w = await world()
    const a = await w.run()
    const b = await w.run(w.connectionId, null)
    await w.drop()
    expect((await w.runRow(a)).status).toBe('paused')
    w.advance(60_000)
    w.published.length = 0
    expect(await w.svc.resume(w.companyId, w.connectionId)).toEqual({ resumed: 2 })
    const ra = await w.runRow(a)
    expect(ra.status).toBe('waiting')
    // Restante na queda (12:00): 10 min; retomado às 12:01 → vence às 12:11.
    expect(ra.wait).toMatchObject({ deadline_at: '2026-10-16T12:11:00.000Z', timer_gen: 1, remaining_ms: null })
    expect(ra.wait).not.toHaveProperty('paused_by')
    expect(ra.wait).not.toHaveProperty('connection_id')
    expect((await w.runRow(b)).wait).toMatchObject({ deadline_at: null, timer_gen: 1 })
    expect(w.scheduled).toEqual([{ data: { runId: a, seq: ra.seq, gen: 1 }, delayMs: 600_000 }])
    expect(w.published).toEqual([
      { companyId: w.companyId, type: 'flow.resumed', data: { connection_id: w.connectionId, session_id: w.sessionId, resumed_count: 2 } },
    ])
    expect(await w.svc.summary(w.companyId, w.connectionId)).toEqual({ paused_count: 0, total_leads: 0 })
  })

  it('Cancelar: cancela os pausados (FlowControl.cancel) e não toca nos de outra conexão', async () => {
    const w = await world()
    const a = await w.run()
    const other = await w.run(w.otherId)
    await w.drop()
    const res = await w.svc.cancel(w.companyId, w.connectionId)
    expect(res).toEqual({ cancelled: [a] })
    expect((await w.runRow(a)).status).toBe('cancelled')
    expect(w.removed.map((t) => t.runId)).toEqual([a])
    expect((await w.runRow(other)).status).toBe('waiting')
  })

  it('conexão de outra empresa ou id inválido → null', async () => {
    const w = await world()
    const z = await world()
    expect(await w.svc.summary(z.companyId, w.connectionId)).toBeNull()
    expect(await w.svc.resume(z.companyId, w.connectionId)).toBeNull()
    expect(await w.svc.cancel(w.companyId, 'nao-e-uuid')).toBeNull()
  })
})
