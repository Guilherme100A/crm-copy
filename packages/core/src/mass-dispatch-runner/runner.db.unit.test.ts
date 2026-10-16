// Postgres real + FakeWaGateway, starter falso: preparação (fases, distribuição), tick (janela, intervalo, limite
// diário, conexão caída, rejeições do gateway) e conclusão.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { MassDispatchService } from '../mass-dispatch/service'
import { prepareMassDispatch, proportionalSplit, runMassDispatchTick, variantForContact, type MassDispatchRunnerDeps, type TickJob } from './runner'
import type { StartResult } from './starter'

let tmp: TempDatabase
let db: Database
let wa: FakeWaGateway
let svc: MassDispatchService
let n = 0
// Segunda-feira, 10:00 em São Paulo.
const MON_10 = Date.parse('2026-10-19T13:00:00Z')

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  wa = new FakeWaGateway()
  svc = new MassDispatchService({ db, waGateway: wa, jobs: { enqueuePrepare: async () => undefined, cancel: async () => undefined } })
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T

async function setup(contacts: number, opts: Record<string, unknown> = {}, connectionsCount = 1) {
  n += 1
  const co = await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t74-${n}-${Date.now()}`}) returning id`)
  const conns: Array<{ id: string; sessionId: string }> = []
  for (let i = 0; i < connectionsCount; i++) {
    const sessionId = `s-t74-${n}-${i}-${Date.now()}`
    wa.addSession({ id: sessionId, name: sessionId, state: 'STABLE' })
    conns.push({ id: (await one<{ id: string }>(sql`insert into crm.connections (company_id, session_id, name) values (${co.id}, ${sessionId}, 'Número teste') returning id`)).id, sessionId })
  }
  const flow = await one<{ id: string }>(sql`insert into crm.flows (company_id, name, status, published_version) values (${co.id}, 'Fluxo', 'active', 1) returning id`)
  const ids: string[] = []
  for (let i = 0; i < contacts; i++)
    ids.push((await one<{ id: string }>(sql`insert into crm.contacts (company_id, name, phone_e164) values (${co.id}, 'C', ${`+55119${String(n).padStart(3, '0')}${String(i).padStart(5, '0')}`}) returning id`)).id)
  await db.execute(sql`insert into crm.mass_dispatch_quota_bonuses (company_id, period, bonus) values (${co.id}, '2026-10', 1000) on conflict do nothing`)
  const { massDispatch } = await svc.create(
    { companyId: co.id, userId: null },
    { targets: conns.map((c) => ({ connection_id: c.id, flow_id: flow.id })), weekdays: [1, 2, 3, 4, 5], manifest: { mode: 'ids', ids }, starts_scheduling_at: new Date(MON_10 - 3_600_000).toISOString(), ...opts },
  )
  return { co: co.id, conns, flow: flow.id, ids, md: massDispatch }
}

function runner(over: Partial<MassDispatchRunnerDeps> & { results?: StartResult[] } = {}) {
  let now = MON_10
  const scheduled: Array<{ job: TickJob; delayMs: number }> = []
  const started: string[] = []
  const events: Array<{ status: string; phase: unknown }> = []
  const results = over.results ?? []
  const deps: MassDispatchRunnerDeps = {
    db,
    wa,
    now: () => new Date(now),
    rng: () => 0.5,
    schedule: async (job, delayMs) => void scheduled.push({ job, delayMs }),
    starter: { start: async (i) => (started.push(i.contactId), results.shift() ?? { ok: true, runId: crypto.randomUUID() }) },
    publisher: { publish: async (_c, _t, data) => void events.push({ status: (data as { status: string }).status, phase: (data as { preparation_progress: { phase: unknown } }).preparation_progress?.phase }) },
    ...over,
  }
  return { deps, scheduled, started, events, advance: (ms: number) => (now += ms), set: (ms: number) => (now = ms) }
}

const status = async (id: string) => (await one<{ status: string }>(sql`select status from crm.mass_dispatches where id = ${id}`)).status

describe('preparação', () => {
  it('fases, distribuição proporcional ao warm-up e 1º tick no horário permitido', async () => {
    const s = await setup(6, {}, 2)
    // Conexão 0 no dia 2 do warm-up (65/dia), conexão 1 no dia 0 (20/dia): 65:20 de 6 → 5 e 1.
    const day2 = new Date(MON_10 - 2 * 86_400_000).toISOString()
    const day0 = new Date(MON_10).toISOString()
    const sessions = {
      get: async (id: string) => ({ ...(await wa.sessions.get(id)), warmupStartedAt: id === s.conns[0]!.sessionId ? day2 : day0 }),
    }
    const r = runner({ wa: { sessions } as unknown as MassDispatchRunnerDeps['wa'] })
    const res = await prepareMassDispatch(r.deps, s.md.id)
    expect(res.status).toBe('scheduled')
    expect(Object.values(res.assigned).sort()).toEqual([1, 5])
    expect(r.events.map((e) => e.phase)).toEqual(['resolving_recipients', 'completed'])
    expect(r.scheduled.map((x) => x.delayMs)).toEqual([0, 0])
    expect(await status(s.md.id)).toBe('scheduled')
  })

  it('opt-out pedido depois da criação vira skipped; disconectada recebe 0', async () => {
    const s = await setup(3, {}, 2)
    await db.execute(sql`update crm.contacts set opt_out = true where id = ${s.ids[0]}`)
    await wa.setSessionState(s.conns[1]!.sessionId, 'DISCONNECTED')
    const r = runner()
    const res = await prepareMassDispatch(r.deps, s.md.id)
    expect(res.target_count).toBe(2)
    expect(res.assigned).toEqual({ [s.md.targets[0]!.id]: 2, [s.md.targets[1]!.id]: 0 })
  })

  it('divisão proporcional', () => {
    expect(proportionalSplit(6, [65, 20])).toEqual([5, 1])
    expect(proportionalSplit(5, [0, 0])).toEqual([3, 2])
    expect(proportionalSplit(4, [10, 0])).toEqual([4, 0])
  })
})

describe('tick', () => {
  it('intervalo pelo RNG, primeiro envio põe running, fim conclui o disparo', async () => {
    const s = await setup(2, { interval_min_seconds: 10, interval_max_seconds: 20 })
    const r = runner()
    await prepareMassDispatch(r.deps, s.md.id)
    const target = s.md.targets[0]!.id
    const t1 = await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })
    expect(t1).toMatchObject({ action: 'started', delay_ms: 15_000 })
    expect(await status(s.md.id)).toBe('running')
    r.advance(15_000)
    expect((await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).action).toBe('started')
    r.advance(15_000)
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'completed' })
    expect(await status(s.md.id)).toBe('completed')
    expect([...r.started].sort()).toEqual([...s.ids].sort())
  })

  it('fora da janela espera o próximo início; limite diário pausa e retoma no próximo dia', async () => {
    const s = await setup(3, { daily_limit: 1 })
    const r = runner()
    await prepareMassDispatch(r.deps, s.md.id)
    const target = s.md.targets[0]!.id
    r.set(Date.parse('2026-10-19T22:00:00Z')) // 19:00 em SP
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'waiting', reason: 'outside_window', next_at: '2026-10-20T11:00:00.000Z' })
    r.set(MON_10)
    expect((await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).action).toBe('started')
    r.advance(60_000)
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'waiting', reason: 'daily_limit', next_at: '2026-10-20T11:00:00.000Z' })
    expect(await status(s.md.id)).toBe('paused')
    r.set(Date.parse('2026-10-20T11:00:00Z'))
    expect((await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).action).toBe('started')
    expect(await status(s.md.id)).toBe('running')
  })

  it('rejeições: limite reagenda, contato bloqueado pula, conexão caída pausa o alvo e volta', async () => {
    const s = await setup(3)
    const r = runner({ results: [{ ok: false, code: 'RATE_LIMIT', message: 'x' }, { ok: false, code: 'CONTACT_NOT_ALLOWED', message: 'opt' }], retryDelayMs: 5_000 })
    await prepareMassDispatch(r.deps, s.md.id)
    const target = s.md.targets[0]!.id
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'rescheduled', reason: 'rate_limit', delay_ms: 5_000 })
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'skipped' })
    await wa.setSessionState(s.conns[0]!.sessionId, 'DISCONNECTED')
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).toMatchObject({ action: 'waiting', reason: 'target_paused' })
    await wa.setSessionState(s.conns[0]!.sessionId, 'STABLE')
    expect((await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: target })).action).toBe('started')
    const st = (await db.execute(sql`select status, count(*)::int as n from crm.mass_dispatch_recipients where dispatch_id = ${s.md.id} group by status order by status`)).rows
    expect(st).toEqual([
      { status: 'pending', n: 1 },
      { status: 'skipped', n: 1 },
      { status: 'started', n: 1 },
    ])
  })

  it('cancelado para; variante A/B igual à do banco', async () => {
    const s = await setup(1, {})
    const r = runner()
    await prepareMassDispatch(r.deps, s.md.id)
    await svc.cancel(s.co, s.md.id)
    expect(await runMassDispatchTick(r.deps, { dispatchId: s.md.id, targetId: s.md.targets[0]!.id })).toMatchObject({ action: 'stopped', reason: 'cancelled' })
    const v = (await db.execute(sql`select case when (hashtext(${s.ids[0]}::uuid::text) & 1) = 1 then 'b' else 'a' end as v`)).rows[0] as { v: string }
    expect(await variantForContact(db, s.ids[0]!)).toBe(v.v)
  })
})
