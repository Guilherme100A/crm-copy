// Harness E2E (T17): rotas /__e2e/* com e sem E2E=1. Redis em db reservado só para o arquivo (T126; antes o 13 fixo) e stream único: o reset apaga
// chaves `crm:*` e não pode atingir testes de outros pacotes rodando no Redis compartilhado.
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, listSeedModules, SEED_BASE, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../app'
import { stopRealtimeHub } from '../routes/events/index'
import { claimTestRedisDb, clearCrmKeys, type TestRedisClaim } from '../test-setup-redis'

let temp: TempDatabase
let db: Database
let redis: RedisClient
// T126: db do Redis reservado só para este arquivo (o reset apaga crm:* no db inteiro); antes era o db 13 fixo.
let claim: TestRedisClaim | undefined
const stream = `e2e-test:${randomBytes(4).toString('hex')}:wsm:events`
const J = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
const logger = createLogger({ level: 'silent' })
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const e2eApp = () => withEnv({ E2E: '1', WA_EVENTS_STREAM: stream }, () => createApp({ db, redis, logger }))

const inbound = (id: string) => ({
  v: 1,
  type: 'message.inbound',
  session_id: 'sess-1',
  at: new Date().toISOString(),
  message: { id, from: '5511999999999@s.whatsapp.net', from_me: false, timestamp: Date.now(), text: 'oi', type: 'conversation' },
})

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  claim = await claimTestRedisDb(expect.getState().testPath)
  redis = redisConnection({ url: claim.url })
  await clearCrmKeys(redis)
}, 60_000)

afterAll(async () => {
  await redis?.del(stream)
  await stopRealtimeHub(redis)
  await db?.$client.end()
  redis?.disconnect()
  await claim?.release()
  await temp?.drop()
})

describe('AC-T17-02 sem E2E=1', () => {
  it('nenhuma rota /__e2e/* existe (404)', async () => {
    const app = withEnv({ E2E: undefined }, () => createApp({ db, redis, logger }))
    for (const [method, path] of [
      ['GET', '/__e2e'],
      ['POST', '/__e2e/reset'],
      ['POST', '/__e2e/wa/emit'],
      ['GET', '/__e2e/wa/deliveries?stream_id=1-0'],
      ['GET', '/__e2e/mail'],
      ['DELETE', '/__e2e/mail'],
      ['GET', '/__e2e/llm/script'],
      ['POST', '/__e2e/llm/script'],
    ] as const) {
      const res = await app.request(path, { method, headers: J, ...(method === 'POST' ? { body: '{}' } : {}) })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('E2E com outro valor também não liga', async () => {
    const app = withEnv({ E2E: 'true' }, () => createApp({ db, redis, logger }))
    expect((await app.request('/__e2e/reset', { method: 'POST' })).status).toBe(404)
  })
})

describe('AC-T17-03 reset', () => {
  it('restaura o seed-base em ≤ 3 s e limpa as chaves de teste', async () => {
    const app = e2eApp()
    await app.request('/__e2e/reset', { method: 'POST' })
    // suja banco e Redis
    await app.request('/api/auth/register', {
      method: 'POST',
      headers: J,
      body: JSON.stringify({ name: 'X', email: 'extra@x.com', password: '12345678', password_confirmation: '12345678' }),
    })
    await db.update(users).set({ name: 'alterado' }).where(eq(users.id, SEED_BASE.users.owner.id))
    await redis.set('crm:rt:t17', '1')
    await redis.set('crm:rl:t17', '1')
    await redis.xadd(stream, '*', 'event', '{}')

    const t0 = Date.now()
    const res = await app.request('/__e2e/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(3000)
    // T37: os seeds de módulo registrados (ex.: ai-prices) rodam depois do seed-base.
    const body = (await res.json()) as { ok: boolean; applied: string[] }
    expect(body).toMatchObject({ ok: true })
    expect(body.applied[0]).toBe('base')
    expect(body.applied).toEqual(['base', ...listSeedModules().map((m) => m.name)])

    const rows = await db.select({ id: users.id, email: users.email, name: users.name }).from(users)
    // T54: o módulo de seed support-user acrescenta support@demo.test (system_role support, sem empresa)
    expect(rows.map((r) => r.email).sort()).toEqual([...Object.values(SEED_BASE.users).map((u) => u.email), 'support@demo.test'].sort())
    expect(rows.find((r) => r.id === SEED_BASE.users.owner.id)?.name).toBe(SEED_BASE.users.owner.name)
    expect(await redis.exists('crm:rt:t17', 'crm:rl:t17')).toBe(0)
    expect(await redis.xlen(stream)).toBe(0)

    for (const u of Object.values(SEED_BASE.users)) {
      const login = await app.request('/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email: u.email, password: SEED_BASE.password }) })
      expect(login.status, u.email).toBe(200)
    }
    // O ≤ 3 s do AC vale para o reset (medido acima); cadastro, logins e o TRUNCATE de mais tabelas a cada
    // migration nova passam do timeout padrão de 5 s do teste inteiro sob carga.
  }, 30_000)
})

describe('AC-T17-04 wa/emit', () => {
  it('evento válido vai para o FakeWaGateway e o stream; consumo do grupo crm aparece em deliveries', async () => {
    const app = e2eApp()
    await redis.xgroup('CREATE', stream, 'crm', '$', 'MKSTREAM').catch(() => undefined)
    const res = await app.request('/__e2e/wa/emit', { method: 'POST', headers: J, body: JSON.stringify({ event: inbound('m-1') }) })
    expect(res.status).toBe(202)
    const { stream_id } = (await res.json()) as { stream_id: string }

    const before = (await (await app.request(`/__e2e/wa/deliveries?stream_id=${stream_id}`)).json()) as Json
    expect(before).toMatchObject({ group: 'crm', delivered: false, acked: false })

    // um consumidor do grupo lê e confirma (o que o StreamConsumer do worker faz)
    const read = (await redis.xreadgroup('GROUP', 'crm', 'test', 'COUNT', 10, 'STREAMS', stream, '>')) as [string, [string, string[]][]][]
    const entry = read[0]![1].find(([id]) => id === stream_id)!
    expect(JSON.parse(entry[1][1]!)).toMatchObject({ type: 'message.inbound', message: { id: 'm-1' } })
    const mid = (await (await app.request(`/__e2e/wa/deliveries?stream_id=${stream_id}`)).json()) as Json
    expect(mid).toMatchObject({ delivered: true, pending: true, acked: false })
    await redis.xack(stream, 'crm', stream_id)
    const after = (await (await app.request(`/__e2e/wa/deliveries?stream_id=${stream_id}&wait_ms=1000`)).json()) as Json
    expect(after).toMatchObject({ delivered: true, pending: false, acked: true })
  })

  it('evento inválido → 422; stream_id inválido → 422', async () => {
    const app = e2eApp()
    expect((await app.request('/__e2e/wa/emit', { method: 'POST', headers: J, body: JSON.stringify({ event: { type: 'x' } }) })).status).toBe(422)
    expect((await app.request('/__e2e/wa/emit', { method: 'POST', headers: J, body: '{' })).status).toBe(400)
    expect((await app.request('/__e2e/wa/deliveries?stream_id=abc')).status).toBe(422)
  })
})

describe('mail e llm', () => {
  it('lista e limpa os e-mails do MemoryMailer', async () => {
    const app = e2eApp()
    await app.request('/__e2e/reset', { method: 'POST' })
    await app.request('/api/auth/password-resets', { method: 'POST', headers: J, body: JSON.stringify({ email: SEED_BASE.users.member.email }) })
    const { items } = (await (await app.request('/__e2e/mail')).json()) as Json
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ to: SEED_BASE.users.member.email })
    expect(items[0].text).toContain('reset-password?token=')
    await app.request('/__e2e/mail', { method: 'DELETE' })
    expect(((await (await app.request('/__e2e/mail')).json()) as Json).items).toEqual([])
  })

  it('roteiro do FakeLlm: enfileira, substitui e valida', async () => {
    const app = e2eApp()
    const post = (body: unknown) => app.request('/__e2e/llm/script', { method: 'POST', headers: J, body: JSON.stringify(body) })
    expect(await (await post({ steps: [{ kind: 'text', text: 'a' }, { kind: 'tool-calls', calls: [{ name: 't', input: {} }] }] })).json()).toEqual({ remaining: 2 })
    expect(await (await post({ steps: [{ kind: 'fail', error: 'x' }] })).json()).toEqual({ remaining: 3 })
    expect(await (await post({ steps: [{ kind: 'output', value: { a: 1 } }], replace: true })).json()).toEqual({ remaining: 1 })
    expect(await (await app.request('/__e2e/llm/script')).json()).toEqual({ remaining: 1, calls: 0 })
    expect((await post({ steps: [{ kind: 'nope' }] })).status).toBe(422)
  })
})
