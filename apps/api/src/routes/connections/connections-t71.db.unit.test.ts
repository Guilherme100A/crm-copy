// T71: limite na lista, fluxos pausados na queda (contagem, Retomar, Cancelar) e a rota do harness que muda o estado
// da sessão no FakeWaGateway publicando no stream (Postgres real, FakeWaGateway, FlowControl com timers falsos).
import { randomBytes } from 'node:crypto'
import { FlowControl, type FlowTimerJobData, type RealtimePublisher } from '@crm/core'
import { chats, companies, contacts, createDb, flowRuns, flows, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createCipher, createLogger, generateCredentialsKey, MemoryMailer, parseEncrypted, redisConnection } from '@crm/node-kit'
import type { WaEvent } from '@crm/wa-port'
import { FAKE_PAIRING_CODE, FAKE_QR_DATA_URL, FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type RedisClient } from '../../app'
import { driveFakeSession } from '../../e2e'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let wa: FakeWaGateway
const scheduled: FlowTimerJobData[] = []
const removed: FlowTimerJobData[] = []
const published: Array<{ companyId: string; type: string; data: Record<string, unknown> }> = []
const cipher = createCipher({ key: generateCredentialsKey() })
const stream = `t71-test:${randomBytes(4).toString('hex')}:wsm:events`
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Session {
  cookie: string
  companyId: string
}

async function signUp(): Promise<Session> {
  const email = `t71-${rnd()}@x.com`
  const ip = { 'x-forwarded-for': `10.71.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }
  const reg = await app.request('/api/auth/register', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ name: 'C', email, password: '12345678', password_confirmation: '12345678' }) })
  const { user } = (await reg.json()) as Json
  const login = await app.request('/api/auth/login', { method: 'POST', headers: { ...H, ...ip }, body: JSON.stringify({ email, password: '12345678' }) })
  const cookie = /crm_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')![0]
  return { cookie, companyId: user.last_company_id }
}

const call = (s: Session, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { ...H, cookie: s.cookie, 'x-company-id': s.companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const json = async (r: Response) => (await r.json()) as Json

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  wa = new FakeWaGateway()
  const flowControl = new FlowControl({
    db,
    shortDelayMs: -1,
    timers: { schedule: async (data) => void scheduled.push(data), cancel: async (data) => void removed.push(data) },
  })
  const realtimePublisher = { publish: async (companyId: string, type: string, data: Record<string, unknown>) => (published.push({ companyId, type, data }), '1-0') } as unknown as RealtimePublisher
  app = withEnv({ E2E: '1', WA_EVENTS_STREAM: stream }, () =>
    createApp({ db, redis, mailer: new MemoryMailer(), trustProxy: true, logger: createLogger({ level: 'silent' }), waGateway: wa, flowControl, realtimePublisher, credentialsCipher: cipher }),
  )
}, 60_000)

afterAll(async () => {
  await redis?.del(stream)
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

async function create(s: Session, name = `Loja ${rnd()}`) {
  const res = await call(s, 'POST', '/api/connections', { name })
  expect(res.status).toBe(201)
  return (await json(res)).connection as Json
}

/** Run pausado pela queda da conexão (como o projetor da T47 deixa). */
async function pausedRun(companyId: string, connectionId: string, remainingMs: number | null = 120_000) {
  const [flow] = await db.insert(flows).values({ companyId, name: `Fluxo ${rnd()}` }).returning()
  const [ct] = await db.insert(contacts).values({ companyId, name: 'C', phoneE164: `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }).returning()
  const [chat] = await db.insert(chats).values({ companyId, contactId: ct!.id, connectionId }).returning()
  const wait = { kind: 'reply', handles: {}, deadline_at: null, timer_gen: 0, remaining_ms: remainingMs, paused_by: 'connection', connection_id: connectionId, paused_at: new Date().toISOString() }
  const [r] = await db.insert(flowRuns).values({ companyId, flowId: flow!.id, contactId: ct!.id, chatId: chat!.id, status: 'paused', wait }).returning()
  return r!.id
}

describe('AC-T71-05 limite de conexões na lista', () => {
  it('sem limite: limits.connections = null; com limite, devolve o teto e o uso (sem as agendadas para exclusão)', async () => {
    const s = await signUp()
    const a = await create(s)
    await create(s)
    expect((await json(await call(s, 'GET', '/api/connections'))).limits).toEqual({ connections: null, used: 2 })
    await db.update(companies).set({ settings: sql`jsonb_set(coalesce(${companies.settings}, '{}'::jsonb), '{limits}', '{"connections": 2}'::jsonb)` }).where(eq(companies.id, s.companyId))
    expect((await json(await call(s, 'GET', '/api/connections'))).limits).toEqual({ connections: 2, used: 2 })
    expect((await call(s, 'POST', '/api/connections', { name: 'Terceira' })).status).toBe(409)
    expect((await call(s, 'POST', `/api/connections/${a.id}/schedule-deletion`)).status).toBe(200)
    expect((await json(await call(s, 'GET', '/api/connections?status=connected'))).limits).toEqual({ connections: 2, used: 1 })
  })
})

describe('AC-T71-03 proxy: senha vazia mantém a salva', () => {
  it('sem senha mantém; nova senha troca; remove_password apaga; senha + remove_password → 422', async () => {
    const s = await signUp()
    const c = await create(s)
    const url = `/api/connections/${c.id}/proxy`
    const enc = async () => (await db.execute(sql`select proxy_password_enc from crm.connections where id = ${c.id}`)).rows[0]!.proxy_password_enc as string | null
    const plain = async () => cipher.decrypt(parseEncrypted((await enc())!), `connection/${c.id}/proxy`)
    const base = { protocol: 'http', host: 'proxy.local', port: 8080, username: 'u1' }

    expect((await json(await call(s, 'POST', url, { ...base, password: 'segredo-1' }))).connection.proxy.has_password).toBe(true)
    for (const keep of [{}, { password: '' }, { password: null }]) {
      const r = await json(await call(s, 'POST', url, { ...base, port: 3128, ...keep }))
      expect(r.connection.proxy).toMatchObject({ port: 3128, has_password: true })
      expect(await plain()).toBe('segredo-1')
    }
    await call(s, 'POST', url, { ...base, password: 'segredo-2' })
    expect(await plain()).toBe('segredo-2')

    expect((await call(s, 'POST', url, { ...base, password: 'x', remove_password: true })).status).toBe(422)
    expect((await call(s, 'POST', url, { ...base, remove_password: 'sim' })).status).toBe(422)
    expect(await plain()).toBe('segredo-2')

    const removed = await json(await call(s, 'POST', url, { ...base, remove_password: true }))
    expect(removed.connection.proxy).toMatchObject({ host: 'proxy.local', has_password: false })
    expect(await enc()).toBeNull()
  })
})

describe('AC-T71-04 Retomar/Cancelar fluxos pausados na queda', () => {
  it('a lista traz paused_flows_count; GET paused-flows conta; resume reagenda e publica flow.resumed', async () => {
    const s = await signUp()
    const c = await create(s)
    const other = await create(s)
    const r1 = await pausedRun(s.companyId, c.id)
    await pausedRun(s.companyId, c.id, null)
    const list = await json(await call(s, 'GET', '/api/connections'))
    expect(list.items.find((i: Json) => i.id === c.id).paused_flows_count).toBe(2)
    expect(list.items.find((i: Json) => i.id === other.id).paused_flows_count).toBe(0)
    expect(await json(await call(s, 'GET', `/api/connections/${c.id}/paused-flows`))).toEqual({ paused_count: 2, total_leads: 2 })

    published.length = 0
    const res = await call(s, 'POST', `/api/connections/${c.id}/paused-flows/resume`)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ resumed: 2 })
    const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, r1))
    expect(row).toMatchObject({ status: 'waiting', wait: { timer_gen: 1, remaining_ms: null } })
    expect(scheduled.some((t) => t.runId === r1 && t.gen === 1)).toBe(true)
    expect(published).toContainEqual({ companyId: s.companyId, type: 'flow.resumed', data: { connection_id: c.id, session_id: c.session_id, resumed_count: 2 } })
    expect(await json(await call(s, 'GET', `/api/connections/${c.id}/paused-flows`))).toEqual({ paused_count: 0, total_leads: 0 })
  })

  it('cancel cancela os pausados e publica flow_run.cancelled; outra empresa → 404', async () => {
    const s = await signUp()
    const c = await create(s)
    const r1 = await pausedRun(s.companyId, c.id)
    published.length = 0
    const res = await call(s, 'POST', `/api/connections/${c.id}/paused-flows/cancel`)
    expect(await json(res)).toEqual({ cancelled: 1 })
    expect((await db.select().from(flowRuns).where(eq(flowRuns.id, r1)))[0]!.status).toBe('cancelled')
    expect(published.filter((p) => p.type === 'flow_run.cancelled').map((p) => p.data.run_id)).toEqual([r1])

    const z = await signUp()
    for (const path of ['paused-flows', 'paused-flows/resume', 'paused-flows/cancel'])
      expect((await call(z, path === 'paused-flows' ? 'GET' : 'POST', `/api/connections/${c.id}/${path}`)).status).toBe(404)
  })
})

describe('AC-T71-02 harness: estado da sessão no FakeWaGateway + stream', () => {
  const read = async (ids: string[]) => {
    const rows = (await redis.xrange(stream, '-', '+')) as [string, string[]][]
    return rows.filter(([id]) => ids.includes(id)).map(([, f]) => JSON.parse(f[1]!) as WaEvent)
  }

  it('qr → session.qr (valor pedido); open → STABLE + connection open; a lista passa a connected', async () => {
    const s = await signUp()
    const c = await create(s)
    const qr = await app.request(`/__e2e/wa/sessions/${c.session_id}/state`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'qr', qr: 'data:image/png;base64,QUJD' }) })
    expect(qr.status).toBe(202)
    const qrBody = await json(qr)
    const qrEvents = await read(qrBody.events.map((e: Json) => e.stream_id))
    expect(qrEvents.map((e) => e.type)).toEqual(['session.qr', 'session.qr'])
    expect(qrEvents.at(-1)).toMatchObject({ qr: 'data:image/png;base64,QUJD' })
    expect((await json(await call(s, 'GET', `/api/connections/${c.id}/qr`))).qr_code).toBe(FAKE_QR_DATA_URL)

    const open = await json(await app.request(`/__e2e/wa/sessions/${c.session_id}/state`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'open' }) }))
    expect(open.session.status).toBe('STABLE')
    expect(open.events.map((e: Json) => e.type)).toEqual(['session.state', 'session.connection'])
    expect((await read(open.events.map((e: Json) => e.stream_id))).at(-1)).toMatchObject({ type: 'session.connection', state: 'open' })
    // A projeção (T47) grava o `open`; aqui aplicamos o mesmo à linha para conferir a leitura da lista.
    await db.execute(sql`update crm.connections set connection_state = 'open' where id = ${c.id}`)
    expect((await json(await call(s, 'GET', '/api/connections'))).items[0]).toMatchObject({ id: c.id, status: 'connected', session_state: 'STABLE' })
  })

  it('close leva reason/status_code; connecting volta a NEW com o código; sessão desconhecida → 404; corpo inválido → 422', async () => {
    const fake = new FakeWaGateway()
    const sess = fake.addSession({ state: 'STABLE' })
    const close = await driveFakeSession(fake, sess.id, { to: 'close', reason: 'forbidden', status_code: 403 })
    expect(close.map((e) => e.type)).toEqual(['session.state', 'session.connection'])
    expect(close[1]).toMatchObject({ state: 'close', reason: 'forbidden', status_code: 403 })
    expect((await fake.sessions.get(sess.id)).status).toBe('DISCONNECTED')

    const connecting = await driveFakeSession(fake, sess.id, { to: 'connecting' })
    expect(connecting.map((e) => e.type)).toEqual(['session.state', 'session.pairing_code'])
    expect(connecting[1]).toMatchObject({ code: FAKE_PAIRING_CODE })

    const reopen = await driveFakeSession(fake, sess.id, { to: 'open', session_state: 'WARMING' })
    expect(reopen.map((e) => e.type)).toEqual(['session.state', 'session.connection'])
    // Já aberta: ainda assim publica o `open` (a projeção decide se é reconexão).
    expect((await driveFakeSession(fake, sess.id, { to: 'open', session_state: 'WARMING' })).map((e) => e.type)).toEqual(['session.connection'])

    expect((await app.request('/__e2e/wa/sessions/nao-existe/state', { method: 'POST', headers: H, body: JSON.stringify({ to: 'open' }) })).status).toBe(404)
    expect((await app.request(`/__e2e/wa/sessions/${sess.id}/state`, { method: 'POST', headers: H, body: JSON.stringify({ to: 'banana' }) })).status).toBe(422)
  })
})
