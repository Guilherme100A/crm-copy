// AC-T74-01..05: preparação com SSE, janela/intervalo/limite diário, erros do gateway e conexão caída, distribuição e A/B,
// cancelamento do run anterior do contato.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envelopeOf } from '../helpers/sse'
import {
  body,
  byIds,
  createDispatch,
  getDispatch,
  newConnection,
  newContact,
  newFlow,
  newOwner,
  openEvents,
  overrideWarmup,
  recipients,
  runner,
  startEnv,
  tick,
  type Env,
  type User,
} from './setup'

let env: Env
beforeAll(async () => {
  env = await startEnv()
  for (const n of ['prepareMassDispatch', 'runMassDispatchTick', 'variantForContact', 'isWithinWindow', 'nextAllowedTime'])
    if (typeof env.core[n] !== 'function') throw new Error(`@crm/core não exporta ${n}`)
})
afterAll(async () => {
  await env?.close()
})

const MON_10_SP = '2026-10-19T13:00:00Z' // segunda-feira 10:00 em America/Sao_Paulo (UTC−3)

async function setup(n: number, extra: Record<string, unknown> = {}, connections = 1) {
  const o = await newOwner(env)
  const conns = []
  for (let i = 0; i < connections; i++) conns.push(await newConnection(env, o.companyId))
  const flow = await newFlow(o)
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await newContact(env, o.companyId, { name: `Pessoa ${i}` }))
  const md = await createDispatch(o, body(conns.map((c) => ({ connection_id: c.id, flow_id: flow.id })), byIds(ids), { time_zone: 'America/Sao_Paulo', ...extra }))
  return { o, conns, flow, ids, md }
}

/** Prepara e devolve o id do 1º alvo. */
async function prepared(s: Awaited<ReturnType<typeof setup>>, r = runner(env, { now: MON_10_SP })) {
  const res = await env.core.prepareMassDispatch(r.deps, s.md.id)
  expect(res.status).toBe('scheduled')
  return { r, res, targetId: s.md.targets[0].id as string }
}

describe('AC-T74-01 preparação com progresso', () => {
  it('AC-T74-01 passa por resolving_recipients → counting → scheduling → completed e publica mass_dispatch.updated', async () => {
    const s = await setup(4)
    const ev = await openEvents(env, s.o, s.o.companyId)
    try {
      const r = runner(env, { now: MON_10_SP, step: 1_500 }) // ≥ 1 s entre leituras do relógio: todas as fases saem
      const res = await env.core.prepareMassDispatch(r.deps, s.md.id)
      expect(res).toMatchObject({ status: 'scheduled', target_count: 4 })
      await ev.waitFor((m) => m.event === 'mass_dispatch.updated' && envelopeOf(m).data?.mass_dispatch_id === s.md.id && envelopeOf(m).data?.preparation_progress?.phase === 'completed', 10_000)
      const data = ev.events('mass_dispatch.updated').map((m) => envelopeOf(m).data).filter((d) => d.mass_dispatch_id === s.md.id)
      const phases = data.map((d) => d.preparation_progress.phase).filter((p, i, a) => a.indexOf(p) === i)
      expect(phases).toEqual(['resolving_recipients', 'counting', 'scheduling', 'completed'])
      const last = data[data.length - 1]
      expect(last).toMatchObject({ status: 'scheduled', preparation_progress: { phase: 'completed', target_count: 4, scheduled_count: 4 }, pending_count: 4 })
      const dto = await getDispatch(s.o, s.md.id)
      expect(dto).toMatchObject({ status: 'scheduled', preparation_progress: { phase: 'completed' } })
      // um tick por alvo foi devolvido para agendar
      expect(res.ticks.map((t: any) => t.targetId)).toEqual([s.md.targets[0].id])
    } finally {
      await ev.close()
    }
  })

  it('AC-T74-01 no máximo 1 evento por segundo: com o relógio parado saem só o primeiro e o final', async () => {
    const s = await setup(3)
    const ev = await openEvents(env, s.o, s.o.companyId)
    try {
      await env.core.prepareMassDispatch(runner(env, { now: MON_10_SP }).deps, s.md.id)
      await ev.waitFor((m) => m.event === 'mass_dispatch.updated' && envelopeOf(m).data?.mass_dispatch_id === s.md.id && envelopeOf(m).data?.preparation_progress?.phase === 'completed', 10_000)
      await new Promise((r) => setTimeout(r, 400))
      const mine = ev.events('mass_dispatch.updated').filter((m) => envelopeOf(m).data?.mass_dispatch_id === s.md.id)
      expect(mine.length, JSON.stringify(mine.map((m) => envelopeOf(m).data.preparation_progress))).toBe(2)
      expect(envelopeOf(mine[1]!).data.preparation_progress.phase).toBe('completed')
    } finally {
      await ev.close()
    }
  })

  it('AC-T74-01 resolving_recipients revê opt-out: quem virou opt-out depois da criação vai para skipped', async () => {
    const s = await setup(3)
    await env.q(`UPDATE crm.contacts SET opt_out = true WHERE id = $1`, [s.ids[1]])
    const { res } = await prepared(s)
    expect(res.target_count).toBe(2)
    const rs = await recipients(s.o, s.md.id)
    expect(rs.find((x: any) => x.contact_id === s.ids[1])).toMatchObject({ status: 'skipped' })
    expect(rs.filter((x: any) => x.status === 'pending')).toHaveLength(2)
  })
})

describe('AC-T74-02 janela, intervalo e limite diário', () => {
  it('AC-T74-02 fora da janela ou do dia da semana (no fuso) espera o próximo início permitido', async () => {
    const s = await setup(2, { weekdays: [1, 2, 3, 4, 5], window_start: '08:00', window_end: '18:00' })
    const { r, targetId } = await prepared(s)
    const cases: Array<[string, string]> = [
      ['2026-10-18T13:00:00Z', '2026-10-19T11:00:00.000Z'], // domingo → segunda 08:00 SP
      ['2026-10-19T10:00:00Z', '2026-10-19T11:00:00.000Z'], // segunda 07:00 SP → 08:00
      ['2026-10-19T22:00:00Z', '2026-10-20T11:00:00.000Z'], // segunda 19:00 SP → terça 08:00
      ['2026-10-23T21:30:00Z', '2026-10-26T11:00:00.000Z'], // sexta 18:30 SP → segunda 08:00
    ]
    for (const [now, next] of cases) {
      r.setNow(now)
      r.scheduled.length = 0
      const t = await tick(env, r, s.md.id, targetId)
      expect(t, now).toMatchObject({ action: 'waiting', reason: 'outside_window' })
      expect(new Date(t.next_at).toISOString()).toBe(next)
      expect(r.scheduled).toHaveLength(1)
      expect(r.scheduled[0]!.delayMs).toBe(Date.parse(next) - Date.parse(now))
      expect(r.scheduled[0]!.job).toMatchObject({ kind: 'tick', dispatchId: s.md.id, targetId })
    }
    expect(env.wa.sent.filter((m: any) => s.ids.includes(m.contactId))).toHaveLength(0)
    r.setNow(MON_10_SP)
    expect(await tick(env, r, s.md.id, targetId)).toMatchObject({ action: 'started' })
    // funções puras no fuso informado
    const sched = { weekdays: [1, 2, 3, 4, 5], windowStart: '08:00', windowEnd: '18:00', timeZone: 'America/Sao_Paulo' }
    expect(env.core.isWithinWindow(new Date(MON_10_SP), sched)).toBe(true)
    expect(env.core.isWithinWindow(new Date('2026-10-19T13:00:00Z'), { ...sched, timeZone: 'Asia/Tokyo' })).toBe(false) // 22:00 em Tóquio
    expect(new Date(env.core.nextAllowedTime(new Date('2026-10-18T13:00:00Z'), sched)).toISOString()).toBe('2026-10-19T11:00:00.000Z')
  })

  it('AC-T74-02 intervalo aleatório entre mín e máx com RNG injetado', async () => {
    const s = await setup(3, { interval_min_seconds: 10, interval_max_seconds: 20 })
    const values = [0, 0.5, 0.999]
    let i = 0
    const r = runner(env, { now: MON_10_SP, rng: () => values[i++ % values.length]! })
    await env.core.prepareMassDispatch(r.deps, s.md.id)
    const targetId = s.md.targets[0].id
    r.scheduled.length = 0
    const delays: number[] = []
    for (let k = 0; k < 3; k++) {
      const t = await tick(env, r, s.md.id, targetId)
      expect(t.action).toBe('started')
      delays.push(t.delay_ms)
      r.advance(t.delay_ms)
    }
    expect(delays).toEqual([10_000, 15_000, 19_990])
    expect(r.scheduled.slice(0, 2).map((x) => x.delayMs)).toEqual([10_000, 15_000])
    // o tick seguinte não acha mais pendentes e conclui o disparo
    expect((await tick(env, r, s.md.id, targetId)).action).toBe('completed')
    const dto = await getDispatch(s.o, s.md.id)
    expect(dto).toMatchObject({ status: 'completed', sent_count: 3, pending_count: 0 })
    expect(dto.first_sent_at).toBeTruthy()
    expect(dto.finished_at).toBeTruthy()
  })

  it('AC-T74-02 limite diário pausa o disparo e retoma no próximo dia permitido', async () => {
    const s = await setup(4, { daily_limit: 2, weekdays: [1, 2, 3, 4, 5], window_start: '08:00', window_end: '18:00' })
    const { r, targetId } = await prepared(s)
    expect((await tick(env, r, s.md.id, targetId)).action).toBe('started')
    expect((await getDispatch(s.o, s.md.id)).status).toBe('running')
    r.advance(60_000)
    expect((await tick(env, r, s.md.id, targetId)).action).toBe('started')
    r.advance(60_000)
    const third = await tick(env, r, s.md.id, targetId)
    expect(third).toMatchObject({ action: 'waiting', reason: 'daily_limit' })
    expect(new Date(third.next_at).toISOString()).toBe('2026-10-20T11:00:00.000Z') // terça 08:00 SP
    expect((await getDispatch(s.o, s.md.id)).status).toBe('paused')
    expect((await recipients(s.o, s.md.id, 'started')).length).toBe(2)

    r.setNow('2026-10-20T11:00:00Z')
    expect((await tick(env, r, s.md.id, targetId)).action).toBe('started')
    expect((await getDispatch(s.o, s.md.id)).status).toBe('running')
  })

  it('AC-T74-02 antes de starts_scheduling_at espera (not_started); disparo cancelado para (stopped)', async () => {
    const s = await setup(2, { starts_scheduling_at: '2026-10-21T15:00:00.000Z' })
    const { r, targetId } = await prepared(s)
    const t = await tick(env, r, s.md.id, targetId)
    expect(t).toMatchObject({ action: 'waiting', reason: 'not_started' })
    expect(Date.parse(t.next_at)).toBeGreaterThanOrEqual(Date.parse('2026-10-21T15:00:00Z'))
    expect((await s.o.c.post(`/api/mass-dispatches/${s.md.id}/cancel`)).status).toBe(200)
    r.scheduled.length = 0
    r.setNow('2026-10-21T15:00:00Z')
    expect(await tick(env, r, s.md.id, targetId)).toMatchObject({ action: 'stopped' })
    expect(r.scheduled).toHaveLength(0)
  })
})

describe('AC-T74-03 erros do gateway e conexão caída', () => {
  it('AC-T74-03 RATE_LIMIT e WARMUP_LIMIT reagendam (não failed); CONTACT_NOT_ALLOWED vira skipped', async () => {
    const s = await setup(2)
    const { r, targetId } = await prepared(s)
    for (const [code, reason] of [
      ['RATE_LIMIT', 'rate_limit'],
      ['WARMUP_LIMIT', 'warmup_limit'],
    ] as const) {
      env.wa.failNext(code)
      r.scheduled.length = 0
      const t = await tick(env, r, s.md.id, targetId)
      expect(t, code).toMatchObject({ action: 'rescheduled', reason, delay_ms: 5_000 })
      expect(r.scheduled[0]?.delayMs).toBe(5_000)
      const rs = await recipients(s.o, s.md.id)
      expect(rs.filter((x: any) => x.status === 'failed')).toHaveLength(0)
      expect(rs.filter((x: any) => x.status === 'pending')).toHaveLength(2)
    }
    env.wa.failNext('CONTACT_NOT_ALLOWED')
    const blocked = await tick(env, r, s.md.id, targetId)
    expect(blocked.action).toBe('skipped')
    const rs = await recipients(s.o, s.md.id)
    expect(rs.find((x: any) => x.id === blocked.recipient_id)).toMatchObject({ status: 'skipped', skip_reason: 'contact_not_allowed' })
    expect(rs.filter((x: any) => x.status === 'failed')).toHaveLength(0)
    // o próximo segue normal
    expect((await tick(env, r, s.md.id, targetId)).action).toBe('started')
  })

  it('AC-T74-03 conexão desconectada pausa só aquele alvo e retoma quando ela volta', async () => {
    const s = await setup(6, {}, 2)
    const { r } = await prepared(s)
    const [tA, tB] = s.md.targets
    const connA = s.conns.find((c) => c.id === tA.connection_id)!
    await env.wa.setSessionState(connA.sessionId, 'DISCONNECTED')
    r.scheduled.length = 0
    const paused = await tick(env, r, s.md.id, tA.id)
    expect(paused).toMatchObject({ action: 'waiting', reason: 'target_paused', delay_ms: 7_000 })
    expect(r.scheduled[0]).toMatchObject({ delayMs: 7_000, job: { targetId: tA.id } })
    expect((await tick(env, r, s.md.id, tB.id)).action).toBe('started') // o outro alvo segue
    const pendingA = (await recipients(s.o, s.md.id)).filter((x: any) => x.target_id === tA.id && x.status === 'pending').length
    expect(pendingA).toBeGreaterThan(0)

    await env.wa.setSessionState(connA.sessionId, 'STABLE')
    r.advance(7_000)
    const resumed = await tick(env, r, s.md.id, tA.id)
    expect(resumed.action).toBe('started')
    expect((await recipients(s.o, s.md.id)).find((x: any) => x.id === resumed.recipient_id)).toMatchObject({ status: 'started', target_id: tA.id })
  })
})

describe('AC-T74-04 distribuição entre alvos e A/B', () => {
  it('AC-T74-04 distribuição proporcional à capacidade restante (warm-up de cada conexão)', async () => {
    const s = await setup(17, {}, 2)
    const [cA, cB] = s.conns
    // A no dia 0 (20), B no dia 2 (round(20·1.8²) = 65) em relação ao relógio do runner
    overrideWarmup(env, cA!.sessionId, MON_10_SP)
    overrideWarmup(env, cB!.sessionId, new Date(Date.parse(MON_10_SP) - 2 * 86_400_000).toISOString())
    const { res } = await prepared(s)
    const tA = s.md.targets.find((t: any) => t.connection_id === cA!.id).id
    const tB = s.md.targets.find((t: any) => t.connection_id === cB!.id).id
    expect(res.assigned).toEqual({ [tA]: 4, [tB]: 13 }) // 17 × 20/85 e 17 × 65/85
    const dto = await getDispatch(s.o, s.md.id)
    expect(Object.fromEntries(dto.targets.map((t: any) => [t.id, t.assigned_count]))).toEqual({ [tA]: 4, [tB]: 13 })

    // maior resto: 10 × 20/85 = 2,35 e 10 × 65/85 = 7,65 → 2 e 8
    const s2 = await setup(10, {}, 2)
    overrideWarmup(env, s2.conns[0]!.sessionId, MON_10_SP)
    overrideWarmup(env, s2.conns[1]!.sessionId, new Date(Date.parse(MON_10_SP) - 2 * 86_400_000).toISOString())
    const res2 = (await prepared(s2)).res
    const byConn = Object.fromEntries(s2.md.targets.map((t: any) => [t.connection_id, res2.assigned[t.id]]))
    expect(byConn).toEqual({ [s2.conns[0]!.id]: 2, [s2.conns[1]!.id]: 8 })

    // conexão desconectada tem capacidade 0
    const s3 = await setup(5, {}, 2)
    await env.wa.setSessionState(s3.conns[1]!.sessionId, 'DISCONNECTED')
    const res3 = (await prepared(s3)).res
    const byConn3 = Object.fromEntries(s3.md.targets.map((t: any) => [t.connection_id, res3.assigned[t.id] ?? 0]))
    expect(byConn3).toEqual({ [s3.conns[0]!.id]: 5, [s3.conns[1]!.id]: 0 })
    const dto3 = await getDispatch(s3.o, s3.md.id)
    expect(Object.fromEntries(dto3.targets.map((t: any) => [t.connection_id, t.assigned_count]))).toEqual(byConn3)
  })

  it('AC-T74-04 A/B 50/50 determinístico por hash do contato: variante bate com variantForContact e com o fluxo iniciado', async () => {
    const o = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    const flowA = await newFlow(o)
    const flowB = await newFlow(o)
    const ids: string[] = []
    for (let i = 0; i < 40; i++) ids.push(await newContact(env, o.companyId))
    const md = await createDispatch(o, body([{ connection_id: conn.id, flow_id: flowA.id }], byIds(ids), { flow_b_id: flowB.id, interval_min_seconds: 0, interval_max_seconds: 0 }))
    const r = runner(env, { now: MON_10_SP })
    await env.core.prepareMassDispatch(r.deps, md.id)
    const rs = await recipients(o, md.id)
    for (const x of rs) expect(x.variant, x.contact_id).toBe(await env.core.variantForContact(env.db, x.contact_id))
    expect(await env.core.variantForContact(env.db, ids[0])).toBe(await env.core.variantForContact(env.db, ids[0]))
    const b = rs.filter((x: any) => x.variant === 'b').length
    expect(b).toBeGreaterThan(8)
    expect(b).toBeLessThan(32)

    for (let k = 0; k < 6; k++) await tick(env, r, md.id, md.targets[0].id)
    const started = (await recipients(o, md.id, 'started')) as any[]
    expect(started).toHaveLength(6)
    for (const x of started) {
      const [run] = await env.q(`SELECT flow_id, contact_id, trigger FROM crm.flow_runs WHERE contact_id = $1 ORDER BY started_at DESC LIMIT 1`, [x.contact_id])
      expect(run.flow_id).toBe(x.variant === 'b' ? flowB.id : flowA.id)
      expect(run.trigger).toMatchObject({ kind: 'mass_dispatch', dispatch_id: md.id })
    }
  })
})

describe('AC-T74-05 cancela o run ativo do destinatário', () => {
  it('AC-T74-05 iniciar o fluxo do destinatário cancela o run ativo anterior dele', async () => {
    const s = await setup(1)
    // run ativo em outro fluxo (disparo manual da T43)
    const other = await newFlow(s.o)
    const [chat] = await env.q(`INSERT INTO crm.chats (company_id, connection_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [s.o.companyId, s.conns[0]!.id, s.ids[0]])
    const manual = await s.o.c.post(`/api/flows/${other.id}/trigger`, { chat_id: chat.id })
    expect(manual.status, manual.text).toBe(201)
    const oldRun = manual.body.run.id
    const { r, targetId } = await prepared(s)
    const t = await tick(env, r, s.md.id, targetId)
    const rec = (await recipients(s.o, s.md.id))[0]
    expect(t.action, `recipient: ${JSON.stringify(rec)}`).toBe('started')
    const [old] = await env.q(`SELECT status FROM crm.flow_runs WHERE id = $1`, [oldRun])
    expect(old.status).toBe('cancelled')
    const [fresh] = await env.q(`SELECT status, flow_id, chat_id FROM crm.flow_runs WHERE id = $1`, [t.run_id])
    expect(fresh.flow_id).toBe(s.flow.id)
    expect(['running', 'waiting', 'completed']).toContain(fresh.status)
    expect(fresh.chat_id).toBe(chat.id) // reaproveita o chat do contato na conexão do alvo
    // a mensagem do fluxo saiu pela sessão do alvo
    expect(env.wa.sent.some((m: any) => m.sessionId === s.conns[0]!.sessionId)).toBe(true)
  })
})
