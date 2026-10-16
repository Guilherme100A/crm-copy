// T117: logout e reset de senha fecham os streams SSE na hora (sem esperar o heartbeat).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RealtimePublisher } from '@crm/core'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { createApp, type RedisClient } from '../../app'
import { stopRealtimeHub } from '../events/index'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let publisher: RealtimePublisher
const mailer = new MemoryMailer()
const prefix = `crm:rt:t117:${randomBytes(4).toString('hex')}`
const rnd = () => randomBytes(4).toString('hex')
const JSON_H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }

interface Sse {
  text: () => string
  endedAt: () => number | null
  cancel: () => Promise<void>
}

async function openSse(cookie: string): Promise<Sse> {
  const res = await app.request('/api/events', { headers: { cookie } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let endedAt: number | null = null
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // cancelado
    }
    endedAt = Date.now()
  })()
  return { text: () => text, endedAt: () => endedAt, cancel: () => reader.cancel().catch(() => undefined) }
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return pred()
}

async function signUp() {
  const email = `t117-${rnd()}@x.com`
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: JSON_H,
    body: JSON.stringify({ name: 'T', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }),
  })
  const { user } = (await reg.json()) as { user: { id: string; last_company_id: string } }
  const login = async () => {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: JSON_H, body: JSON.stringify({ email, password: 's3nha-forte' }) })
    return `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`
  }
  return { email, user, login }
}

/** Publica um evento e espera que chegue a todos os streams: garante que já estão assinando o hub. */
async function ready(companyId: string, ...streams: Sse[]) {
  const name = `ready-${rnd()}`
  await publisher.publish(companyId, 'company.updated', { name })
  expect(await waitFor(() => streams.every((s) => s.text().includes(name)), 3000)).toBe(true)
}

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  publisher = new RealtimePublisher({ redis, prefix })
  // Heartbeat longo: o fechamento só pode vir do aviso de logout/reset.
  app = createApp({ db, redis, mailer, realtime: { prefix, heartbeatMs: 60_000 }, logger: createLogger({ level: 'silent' }) })
}, 60_000)

afterAll(async () => {
  await stopRealtimeHub(redis)
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
})

describe('T117 logout/reset encerram o SSE', () => {
  it('logout fecha em < 2 s o stream da mesma sessão; outra sessão do usuário continua recebendo', async () => {
    const { user, login } = await signUp()
    const [a, b] = [await login(), await login()]
    const sa = await openSse(a)
    const sb = await openSse(b)
    await ready(user.last_company_id, sa, sb)

    const t0 = Date.now()
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie: a, 'x-requested-with': 'crm' } })
    expect(out.status).toBe(200)
    expect(await waitFor(() => sa.endedAt() !== null, 2000)).toBe(true)
    expect(sa.endedAt()! - t0).toBeLessThan(2000)

    await ready(user.last_company_id, sb)
    expect(sb.endedAt()).toBeNull()
    await sb.cancel()
  })

  it('reset de senha concluído fecha em < 2 s todos os streams do usuário, e só dele', async () => {
    const { email, user, login } = await signUp()
    const other = await signUp()
    const s1 = await openSse(await login())
    const s2 = await openSse(await login())
    const so = await openSse(await other.login())
    await ready(user.last_company_id, s1, s2)
    await ready(other.user.last_company_id, so)

    await app.request('/api/auth/password-resets', { method: 'POST', headers: JSON_H, body: JSON.stringify({ email }) })
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.last(email)!.text!)![1]
    const t0 = Date.now()
    const res = await app.request(`/api/auth/password-resets/${token}`, {
      method: 'PATCH',
      headers: JSON_H,
      body: JSON.stringify({ password: 'nova-senha-1', password_confirmation: 'nova-senha-1' }),
    })
    expect(res.status).toBe(200)
    expect(await waitFor(() => s1.endedAt() !== null && s2.endedAt() !== null, 2000)).toBe(true)
    expect(Math.max(s1.endedAt()!, s2.endedAt()!) - t0).toBeLessThan(2000)

    await ready(other.user.last_company_id, so)
    expect(so.endedAt()).toBeNull()
    await so.cancel()
  })
})
