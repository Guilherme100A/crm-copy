// AC-T96-02 pela API: GET /api/admin/health com filas BullMQ reais (prefixo único deste arquivo), Redis de teste,
// Postgres temporário e um stream de eventos próprio (adminOps.waEventsStream) com o grupo `crm`.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { owner, platformAdmin, startEnv, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const RUN = randomBytes(4).toString('hex')
const PREFIX = `t96acc-${RUN}`
const STREAM = `t96acc:events:${RUN}`
const Q_BUSY = 'mass-dispatch'
const Q_PAUSED = 'exports'
const Q_FAILED = 'schedules'

let env: Env
let admin: User
const queues: Any[] = []
const workers: Any[] = []

beforeAll(async () => {
  env = await startEnv({ adminOps: { queuePrefix: PREFIX, waEventsStream: STREAM } })
  admin = await platformAdmin(env)
}, 120_000)

afterAll(async () => {
  for (const w of workers) await w.close().catch(() => {})
  for (const q of queues) {
    await q.obliterate?.({ force: true }).catch(() => {})
    await q.close().catch(() => {})
  }
  await env?.redis.del(STREAM).catch(() => {})
  await env?.close()
}, 60_000)

function queue(name: string) {
  const q = env.core.defineQueue(name, { prefix: PREFIX })
  queues.push(q)
  return q
}

describe('T96 — saúde da infra (AC-T96-02)', () => {
  it('AC-T96-02 só platform_admin: dono → 403, sem sessão → 401', async () => {
    const o = await owner(env)
    expect((await o.c.get('/api/admin/health')).status).toBe(403)
    expect((await env.app.request('/api/admin/health')).status).toBe(401)
  })

  it('AC-T96-02 contagens por fila BullMQ: waiting, active, failed, delayed e paused', async () => {
    const busy = queue(Q_BUSY)
    await busy.add('a', { n: 1 })
    await busy.add('b', { n: 2 })
    await busy.add('c', { n: 3 }, { delay: 3_600_000 })

    const paused = queue(Q_PAUSED)
    await paused.pause()
    await paused.add('p', { n: 1 })

    const failing = queue(Q_FAILED)
    await failing.add('f', { n: 1 }, { attempts: 1 })
    const worker = env.core.defineWorker(Q_FAILED, async () => {
      throw new Error('falha de teste T96')
    }, { prefix: PREFIX })
    workers.push(worker)
    const deadline = Date.now() + 15_000
    while ((await failing.getJobCounts('failed')).failed < 1) {
      if (Date.now() > deadline) throw new Error('job não falhou a tempo')
      await new Promise((r) => setTimeout(r, 100))
    }
    await worker.close()

    const r = await admin.c.get('/api/admin/health')
    expect(r.status, r.text).toBe(200)
    expect(r.body.queue_prefix).toBe(PREFIX)
    expect(typeof r.body.checked_at).toBe('string')
    const byName = new Map<string, Any>(r.body.queues.map((q: Any) => [q.name, q]))

    for (const q of r.body.queues) {
      expect(q, q.name).toMatchObject({ status: 'ok' })
      for (const k of ['waiting', 'active', 'failed', 'delayed', 'paused']) expect(typeof q[k], `${q.name}.${k}`).toBe('number')
    }
    expect(byName.get(Q_BUSY)).toMatchObject({ waiting: 2, active: 0, failed: 0, delayed: 1, paused: 0, is_paused: false })
    expect(byName.get(Q_PAUSED)).toMatchObject({ paused: 1, is_paused: true, failed: 0, delayed: 0 })
    expect(byName.get(Q_FAILED)).toMatchObject({ failed: 1, waiting: 0, active: 0 })
    // a lista monitorada inclui as filas do worker (inclusive as que só existem no apps/worker)
    for (const name of ['flow-step', 'ai-knowledge', 'mass-dispatch', 'exports', 'schedules']) expect(byName.has(name), name).toBe(true)
  }, 60_000)

  it('AC-T96-02 Redis (memória) e Postgres (conexões e tamanho)', async () => {
    const r = await admin.c.get('/api/admin/health')
    expect(r.status).toBe(200)
    expect(r.body.redis.status).toBe('ok')
    expect(r.body.redis.used_memory_bytes).toBeGreaterThan(0)
    expect(r.body.postgres.status).toBe('ok')
    expect(r.body.postgres.connections).toBeGreaterThanOrEqual(1)
    expect(r.body.postgres.database_size_bytes).toBeGreaterThan(0)
    // tamanho do banco atual (o temporário), não outro
    const [{ size }] = await env.q(`SELECT pg_database_size(current_database())::bigint AS size`)
    expect(r.body.postgres.database_size_bytes).toBeGreaterThan(Number(size) * 0.5)
    expect(r.body.postgres.database_size_bytes).toBeLessThan(Number(size) * 2)
  })

  it('AC-T96-02 lag do grupo crm no stream: inexistente → exists false/lag null; com entradas → lag e pending', async () => {
    await env.redis.del(STREAM)
    let r = await admin.c.get('/api/admin/health')
    expect(r.status).toBe(200)
    expect(r.body.wa_events).toMatchObject({ stream: STREAM, group: 'crm', exists: false, lag: null })

    for (let i = 0; i < 5; i++) await env.redis.xadd(STREAM, '*', 'type', 'test', 'n', String(i))
    // grupo de outro consumidor não conta
    await env.redis.xgroup('CREATE', STREAM, 'outro', '$')
    r = await admin.c.get('/api/admin/health')
    expect(r.body.wa_events).toMatchObject({ exists: false, lag: null })

    await env.redis.xgroup('CREATE', STREAM, 'crm', '0')
    r = await admin.c.get('/api/admin/health')
    expect(r.body.wa_events).toMatchObject({ status: 'ok', stream: STREAM, group: 'crm', exists: true, lag: 5, pending: 0 })

    await env.redis.xreadgroup('GROUP', 'crm', 'c1', 'COUNT', 2, 'STREAMS', STREAM, '>')
    r = await admin.c.get('/api/admin/health')
    expect(r.body.wa_events).toMatchObject({ exists: true, lag: 3, pending: 2, consumers: 1 })
    expect(r.body.status).toBe('ok')
  })

  it('AC-T96-02 sem injeção o stream monitorado é wsm:events', async () => {
    const app = env.makeApp({ adminOps: { now: env.clock.now, queuePrefix: PREFIX, queues: [Q_BUSY] } })
    const u = await platformAdmin(env, app)
    const r = await u.c.get('/api/admin/health')
    expect(r.status, r.text).toBe(200)
    expect(r.body.wa_events.stream).toBe('wsm:events')
    expect(r.body.wa_events.group).toBe('crm')
    expect(r.body.queues.map((q: Any) => q.name)).toEqual([Q_BUSY])
  })
})
