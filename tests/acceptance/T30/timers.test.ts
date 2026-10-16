// AC-T30-01..05: espera de resposta com timeout, timers delayed, cancelamento, pausa/retomada e limite de 31 dias.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DAY, MIN, definition, edge, fakeTimers, harness, loadWorker, node, runRow, sleep, startEnv, timerQueue, type Env } from './support'

let env: Env
beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const replyWait = (delayMs = 60 * MIN) => () => env.core.waitForReply({ delayMs })

describe('AC-T30-01 espera de resposta com timeout', () => {
  it('AC-T30-01 resposta antes do prazo segue o handle de resposta; o timer depois vira no-op', async () => {
    const t = fakeTimers()
    const h = await harness(env, replyWait(), { timers: t.scheduler })
    const waiting = await runRow(env, h.runId)
    expect(waiting.status).toBe('waiting')
    expect(waiting.wait.kind).toBe('reply')
    expect(t.scheduled).toHaveLength(1)
    expect(t.scheduled[0]!.delayMs).toBe(60 * MIN)

    const r = await h.control.resolveReply(h.runId, { text: 'quero comprar', message_id: 'm1' })
    expect(r).toMatchObject({ advanced: true, handle: 'source' })
    await h.drain()
    expect(h.visited).toEqual(['W', 'R'])
    const done = await runRow(env, h.runId)
    expect(done.status).toBe('completed')
    expect(done.vars.last_user_message).toBe('quero comprar')

    const late = await h.control.fireTimer(t.scheduled[0]!.data)
    expect(late.advanced).toBe(false)
    expect(h.visited).toEqual(['W', 'R'])
  })

  it('AC-T30-01 sem resposta, o timer segue o handle timeout', async () => {
    const t = fakeTimers()
    const h = await harness(env, replyWait(), { timers: t.scheduler })
    const fired = await h.control.fireTimer(t.scheduled[0]!.data)
    expect(fired).toMatchObject({ advanced: true, handle: 'timeout' })
    await h.drain()
    expect(h.visited).toEqual(['W', 'T'])
    expect((await runRow(env, h.runId)).status).toBe('completed')
    // resposta tardia não reabre a espera
    expect((await h.control.resolveReply(h.runId, { text: 'tarde' })).advanced).toBe(false)
  })

  it('AC-T30-01 o processor do job flow-timer dispara o timeout', async () => {
    const { createFlowTimerProcessor } = await loadWorker()
    const t = fakeTimers()
    const h = await harness(env, replyWait(), { timers: t.scheduler })
    const processor = createFlowTimerProcessor({ control: h.control })
    await processor({ data: t.scheduled[0]!.data })
    await h.drain()
    expect(h.visited).toEqual(['W', 'T'])
  })

  it('AC-T30-01 corrida: resposta e timer simultâneos → só um avança', async () => {
    for (let i = 0; i < 6; i++) {
      const t = fakeTimers()
      const h = await harness(env, replyWait(), { timers: t.scheduler })
      const [reply, timer] = await Promise.all([h.control.resolveReply(h.runId, { text: `r${i}` }), h.control.fireTimer(t.scheduled[0]!.data)])
      const advanced = [reply, timer].filter((x: any) => x.advanced)
      expect(advanced, JSON.stringify([reply, timer])).toHaveLength(1)
      const loser = [reply, timer].find((x: any) => !x.advanced)
      expect(['not_waiting', 'stale']).toContain(loser.reason)
      await h.drain()
      expect(h.visited).toHaveLength(2)
      expect(['R', 'T']).toContain(h.visited[1])
      const run = await runRow(env, h.runId)
      expect(run.status).toBe('completed')
      expect(run.seq).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('AC-T30-02 atraso longo como job delayed', () => {
  it('AC-T30-02 atraso de 2 dias agenda job delayed com jobId determinístico', async () => {
    const queue = timerQueue(env)
    const h = await harness(env, () => env.core.waitDelay(2 * DAY), { timers: env.core.bullTimerScheduler(queue), def: definition([node('W', 'smart_interval'), node('R')], [edge('start', 'source', 'W'), edge('W', 'source', 'R')]) })
    const run = await runRow(env, h.runId)
    expect(run.status).toBe('waiting')
    const jobId = env.core.flowTimerJobId({ runId: h.runId, seq: run.seq })
    expect(jobId).toBe(`timer-${h.runId}-seq-${run.seq}`)
    expect(jobId).not.toContain(':')
    const job = await queue.getJob(jobId)
    expect(job, `job ${jobId} não encontrado`).toBeTruthy()
    expect(await job.getState()).toBe('delayed')
    expect(Math.abs(job.delay - 2 * DAY)).toBeLessThan(MIN)
    expect(job.data).toMatchObject({ runId: h.runId, seq: run.seq })
    const all = await queue.getJobs(['delayed', 'waiting', 'active'])
    expect(all).toHaveLength(1)
  })

  it('AC-T30-02 reagendar o mesmo passo não cria job duplicado', async () => {
    const queue = timerQueue(env)
    const sched = env.core.bullTimerScheduler(queue)
    const h = await harness(env, () => env.core.waitDelay(2 * DAY), { timers: sched, def: definition([node('W', 'smart_interval'), node('R')], [edge('start', 'source', 'W'), edge('W', 'source', 'R')]) })
    const run = await runRow(env, h.runId)
    const data = { runId: h.runId, seq: run.seq }
    await sched.schedule(data, 2 * DAY)
    await sched.schedule(data, 2 * DAY)
    // reexecutar o passo antigo (job flow-step duplicado) também não agenda de novo
    await h.engine.step(h.runId, 0)
    const all = await queue.getJobs(['delayed', 'waiting', 'active'])
    expect(all.map((j: any) => j.id)).toEqual([env.core.flowTimerJobId(data)])
  })

  it('AC-T30-02 atraso curto (≤ 5 s) roda em processo, sem job na fila', async () => {
    const queue = timerQueue(env)
    const h = await harness(env, () => env.core.waitDelay(1_500), { timers: env.core.bullTimerScheduler(queue), def: definition([node('W', 'smart_interval'), node('R')], [edge('start', 'source', 'W'), edge('W', 'source', 'R')]) })
    expect(await queue.getJobs(['delayed', 'waiting', 'active'])).toHaveLength(0)
    const deadline = Date.now() + 6_000
    while (!h.enqueued.length && Date.now() < deadline) await sleep(100)
    expect(h.enqueued.length, 'o atraso curto não avançou sozinho').toBeGreaterThan(0)
    await h.drain()
    expect(h.visited).toEqual(['W', 'R'])
    expect((await runRow(env, h.runId)).status).toBe('completed')
  })
})

describe('AC-T30-03 cancelamento', () => {
  it('AC-T30-03 cancel deixa o run cancelled, remove o timer e o timer antigo vira no-op', async () => {
    const { createFlowTimerProcessor } = await loadWorker()
    const queue = timerQueue(env)
    const h = await harness(env, replyWait(3 * DAY), { timers: env.core.bullTimerScheduler(queue) })
    const run = await runRow(env, h.runId)
    const data = { runId: h.runId, seq: run.seq }
    expect(await queue.getJob(env.core.flowTimerJobId(data))).toBeTruthy()

    const res = await h.control.cancel(h.runId)
    expect(res.cancelled).toBe(true)
    const after = await runRow(env, h.runId)
    expect(after.status).toBe('cancelled')
    expect(await queue.getJob(env.core.flowTimerJobId(data))).toBeFalsy()
    expect(await queue.getJobs(['delayed', 'waiting', 'active'])).toHaveLength(0)

    const fired = await h.control.fireTimer(data)
    expect(fired).toMatchObject({ advanced: false, reason: 'cancelled' })
    await createFlowTimerProcessor({ control: h.control })({ data })
    expect((await h.control.resolveReply(h.runId, { text: 'oi' })).advanced).toBe(false)
    await h.drain()
    expect(h.visited).toEqual(['W'])
    expect((await runRow(env, h.runId)).status).toBe('cancelled')
  })
})

describe('AC-T30-04 pausa e retomada', () => {
  it('AC-T30-04 pausar congela o run em espera (timer vencido não avança) e retomar reagenda com o restante', async () => {
    const queue = timerQueue(env)
    const t0 = Date.parse('2026-10-16T12:00:00Z')
    let clock = t0
    const now = () => new Date(clock)
    const h = await harness(env, () => env.core.waitForReply({ delayMs: 10 * MIN, now }), { timers: env.core.bullTimerScheduler(queue), now, shortDelayMs: 0 })
    const run = await runRow(env, h.runId)
    const gen0 = { runId: h.runId, seq: run.seq }
    expect(await queue.getJob(env.core.flowTimerJobId(gen0))).toBeTruthy()

    clock = t0 + 4 * MIN
    const paused = await h.control.pauseFlow({ companyId: h.companyId }, h.flowId)
    expect(paused.paused_runs).toBe(1)
    expect((await runRow(env, h.runId)).status).toBe('paused')
    const [f] = await env.q(`SELECT status FROM crm.flows WHERE id = $1`, [h.flowId])
    expect(f.status).toBe('paused')
    expect(await queue.getJobs(['delayed', 'waiting', 'active'])).toHaveLength(0)

    // o prazo original vence com o fluxo pausado: nada avança (timer nem resposta)
    clock = t0 + 30 * MIN
    expect(await h.control.fireTimer(gen0)).toMatchObject({ advanced: false, reason: 'paused' })
    await h.drain()
    expect(h.visited).toEqual(['W'])
    expect((await runRow(env, h.runId)).status).toBe('paused')

    const resumed = await h.control.resumeFlow({ companyId: h.companyId }, h.flowId)
    expect(resumed.resumed_runs).toBe(1)
    const back = await runRow(env, h.runId)
    expect(back.status).toBe('waiting')
    expect(Date.parse(back.wait.deadline_at) - clock).toBe(6 * MIN)
    const jobs = await queue.getJobs(['delayed', 'waiting', 'active'])
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(env.core.flowTimerJobId({ ...gen0, gen: 1 }))
    expect(Math.abs(jobs[0].delay - 6 * MIN)).toBeLessThan(2_000)

    // o timer da geração antiga é no-op; o novo segue timeout
    expect((await h.control.fireTimer(gen0)).advanced).toBe(false)
    const fired = await h.control.fireTimer({ ...gen0, gen: 1 })
    expect(fired).toMatchObject({ advanced: true, handle: 'timeout' })
    await h.drain()
    expect(h.visited).toEqual(['W', 'T'])
  })

  it('AC-T30-04 resposta chegando com o fluxo pausado não avança o run', async () => {
    const t = fakeTimers()
    const h = await harness(env, replyWait(), { timers: t.scheduler })
    await h.control.pauseFlow({ companyId: h.companyId }, h.flowId)
    expect((await h.control.resolveReply(h.runId, { text: 'oi' })).advanced).toBe(false)
    expect((await runRow(env, h.runId)).status).toBe('paused')
    await h.control.resumeFlow({ companyId: h.companyId }, h.flowId)
    expect((await h.control.resolveReply(h.runId, { text: 'oi de novo' })).advanced).toBe(true)
    await h.drain()
    expect(h.visited).toEqual(['W', 'R'])
  })
})

describe('AC-T30-05 prazo máximo de 31 dias', () => {
  it('AC-T30-05 definição com espera ou intervalo acima de 31 dias → erro de validação', async () => {
    const flows: any = await import('@crm/shared/flows')
    const bad = (type: string, config: any) => definition([node('W', type, config), node('R')], [edge('start', 'source', 'W'), edge('W', 'source', 'R')])
    for (const [type, cfg] of [
      ['wait_response', { wait_indefinitely: false, timeout_value: 32, timeout_unit: 'days' }],
      ['smart_interval', { schedule_type: 'time', interval_value: 32, interval_unit: 'days' }],
      ['wait_response', { wait_indefinitely: false, timeout_value: 745, timeout_unit: 'hours' }],
    ] as const) {
      const errors = flows.validate(bad(type, cfg))
      expect(errors.some((e: any) => e.nodeId === 'W' && e.code === 'invalid_action_config'), `${type} ${JSON.stringify(cfg)}: ${JSON.stringify(errors)}`).toBe(true)
    }
    // 31 dias exatos é aceito
    expect(flows.validate(bad('wait_response', { wait_indefinitely: false, timeout_value: 31, timeout_unit: 'days' }))).toEqual([])
  })

  it('AC-T30-05 em execução, pedir espera acima de 31 dias é recusado (wait_too_long) e o run falha', async () => {
    expect(() => env.core.waitDelay(32 * DAY)).toThrow(/wait_too_long|31/)
    expect(() => env.core.waitForReply({ delayMs: 32 * DAY })).toThrow(/wait_too_long|31/)
    expect(() => env.core.waitDelay(31 * DAY)).not.toThrow()
    const t = fakeTimers()
    const h = await harness(env, () => env.core.waitForReply({ delayMs: 40 * DAY }), { timers: t.scheduler })
    const run = await runRow(env, h.runId)
    expect(run.status).toBe('failed')
    expect(String(run.error)).toContain('wait_too_long')
    expect(t.scheduled).toHaveLength(0)
  })
})
