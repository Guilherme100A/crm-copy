// AC-T08-01 — GET /health sem auth: { status, db, redis }; Redis fora → redis: "down" e ainda 200.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Env, startEnv } from './setup'

describe('T08 — /health', () => {
  let up: Env
  let down: Env

  beforeAll(async () => {
    up = await startEnv()
    down = await startEnv({ deadRedis: true })
  })
  afterAll(async () => {
    await up?.close()
    await down?.close()
  })

  it('AC-T08-01 GET /health → 200 { status, db, redis } sem autenticação', async () => {
    const res = await up.app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('db')
    expect(body).toHaveProperty('redis')
    expect(body.db).not.toBe('down')
    expect(body.redis).not.toBe('down')
  })

  it('AC-T08-01 /health não exige cookie nem token e não devolve dados sensíveis', async () => {
    const res = await up.app.request('/health', { headers: { cookie: 'crm_session=invalido' } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/postgres:\/\/|redis:\/\/|password/i)
  })

  it('AC-T08-01 com Redis fora → 200 e redis: "down" (responde em poucos segundos)', async () => {
    const t0 = Date.now()
    const res = await down.app.request('/health')
    const elapsed = Date.now() - t0
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.redis).toBe('down')
    expect(body.db).not.toBe('down')
    expect(body).toHaveProperty('status')
    expect(elapsed, `levou ${elapsed} ms`).toBeLessThan(5_000)
  })
})
