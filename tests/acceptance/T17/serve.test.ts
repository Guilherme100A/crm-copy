// AC-T17-01/03/04 — serve.mjs real: sobe em ≤ 60 s, reset restaura o seed e limpa Redis, wa/emit entrega ao worker; ao encerrar remove o banco.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '@crm/db'
import { redisConnection } from '@crm/node-kit'
import { http, inboundEvent, startServe, type ServeProc } from './serve'

const BASE_DB = process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm'
const E2E_REDIS = 'redis://127.0.0.1:6379/14'
const withDb = (name: string) => {
  const u = new URL(BASE_DB)
  u.pathname = `/${name}`
  return u.toString()
}

let serve: ServeProc
let admin: any // conexão ao servidor base (pg_database)
let e2eDb: any // conexão ao banco descartável do serve
let redis: any
let SEED: any
let stopped = false

const dbExists = async (name: string) => (await admin.$client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name])).rowCount === 1

beforeAll(async () => {
  const dbMod: any = await import('@crm/db')
  SEED = dbMod.SEED_BASE
  serve = await startServe({ E2E_REDIS_URL: E2E_REDIS, DATABASE_URL: BASE_DB })
  admin = createDb(BASE_DB)
  if (serve.info.database) e2eDb = createDb(withDb(serve.info.database))
  redis = redisConnection({ url: E2E_REDIS })
  redis.on?.('error', () => {})
}, 120_000)

afterAll(async () => {
  await e2eDb?.$client.end().catch(() => {})
  if (!stopped) {
    await serve?.stop(20_000).catch(() => null)
    await serve?.kill()
  }
  if (serve?.info.database && (await dbExists(serve.info.database).catch(() => false)))
    await admin.$client.query(`DROP DATABASE IF EXISTS "${serve.info.database}" WITH (FORCE)`).catch(() => {})
  await admin?.$client.end().catch(() => {})
  await Promise.resolve(redis?.quit()).catch(() => redis?.disconnect())
}, 60_000)

describe('T17 — serve.mjs', () => {
  it('AC-T17-01 serve.mjs sobe e responde GET /health em ≤ 60 s; imprime URLs e o banco descartável', async () => {
    expect(serve.readyMs, serve.output()).toBeLessThanOrEqual(60_000)
    expect(serve.info.apiUrl, serve.output()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(['up', 'absent']).toContain(serve.info.web)
    expect(serve.info.database, serve.output()).toMatch(/^crm_e2e_/)
    const health = await http(serve.info.apiUrl, 'GET', '/health')
    expect(health.status, health.text).toBe(200)
    expect(await dbExists(serve.info.database)).toBe(true)
  })

  it('AC-T17-01 o seed-base está aplicado: usuários do SEED_BASE logam com a senha conhecida', async () => {
    expect(SEED?.password, '@crm/db deve exportar SEED_BASE').toBeTruthy()
    for (const key of ['owner', 'admin', 'member', 'platformAdmin']) {
      const u = SEED.users[key]
      const res = await http(serve.info.apiUrl, 'POST', '/api/auth/login', { email: u.email, password: SEED.password }, { 'x-forwarded-for': `10.9.0.${key.length}` })
      expect(res.status, `${key}: ${res.text}`).toBe(200)
    }
    const owner = await http(serve.info.apiUrl, 'POST', '/api/auth/login', { email: SEED.users.owner.email, password: SEED.password })
    expect(owner.body.companies.map((c: any) => c.name)).toContain('Empresa Demo')
  })
})

describe('T17 — /__e2e/reset', () => {
  it('AC-T17-03 reset restaura o seed-base em ≤ 3 s (dados extras somem, ids fixos voltam)', async () => {
    const q = (sql: string, p: unknown[] = []) => e2eDb.$client.query(sql, p)
    await q(`INSERT INTO crm.companies (name, slug) VALUES ('Empresa Extra T17', $1)`, [`extra-${randomBytes(3).toString('hex')}`])
    await q(`UPDATE crm.companies SET name = 'Renomeada T17' WHERE id = $1`, [SEED.company.id])
    await q(`DELETE FROM crm.company_members WHERE user_id = $1`, [SEED.users.member.id])

    const t0 = Date.now()
    const res = await http(serve.info.apiUrl, 'POST', '/__e2e/reset', {})
    const took = Date.now() - t0
    expect(res.status, res.text).toBe(200)
    expect(took, `reset levou ${took} ms`).toBeLessThanOrEqual(3_000)

    const companies = (await q(`SELECT id, name FROM crm.companies ORDER BY name`)).rows
    expect(companies.some((c: any) => c.name === 'Empresa Extra T17')).toBe(false)
    expect(companies.find((c: any) => c.id === SEED.company.id)?.name).toBe('Empresa Demo')
    const members = (await q(`SELECT user_id, role FROM crm.company_members WHERE company_id = $1`, [SEED.company.id])).rows
    const roleOf = (id: string) => members.find((m: any) => m.user_id === id)?.role
    expect(roleOf(SEED.users.owner.id)).toBe('owner')
    expect(roleOf(SEED.users.admin.id)).toBe('admin')
    expect(roleOf(SEED.users.member.id)).toBe('member')
    const login = await http(serve.info.apiUrl, 'POST', '/api/auth/login', { email: SEED.users.member.email, password: SEED.password })
    expect(login.status, login.text).toBe(200)
  })

  it('AC-T17-03 reset limpa streams e chaves de teste no Redis da e2e (mantém o grupo do stream WA)', async () => {
    await redis.xadd('wsm:events', '*', 'event', JSON.stringify({ sujo: true }))
    await redis.set('crm:rt:sujeira-t17', '1')
    await redis.set('crm:rl:sujeira-t17', '1')
    await redis.xadd('crm:wa-events:dlq', '*', 'event', '{}')
    await redis.xadd('crm:rt:company-t17', '*', 'event', '{}')

    const res = await http(serve.info.apiUrl, 'POST', '/__e2e/reset', {})
    expect(res.status, res.text).toBe(200)
    expect(await redis.xlen('wsm:events')).toBe(0)
    expect(await redis.exists('crm:rt:sujeira-t17', 'crm:rl:sujeira-t17', 'crm:rt:company-t17')).toBe(0)
    expect(await redis.xlen('crm:wa-events:dlq')).toBe(0)
    const groups: any[] = await redis.xinfo('GROUPS', 'wsm:events')
    expect(JSON.stringify(groups)).toContain('crm')
  })

  it('AC-T17-03 reset limpa os e-mails capturados (/__e2e/mail)', async () => {
    const r = await http(serve.info.apiUrl, 'POST', '/api/auth/password-resets', { email: SEED.users.owner.email })
    expect(r.status, r.text).toBe(200)
    const before = await http(serve.info.apiUrl, 'GET', '/__e2e/mail')
    expect(before.status).toBe(200)
    expect(before.body.items.length).toBeGreaterThanOrEqual(1)
    expect(before.body.items.some((m: any) => JSON.stringify(m.to).includes(SEED.users.owner.email))).toBe(true)
    await http(serve.info.apiUrl, 'POST', '/__e2e/reset', {})
    const after = await http(serve.info.apiUrl, 'GET', '/__e2e/mail')
    expect(after.body.items).toHaveLength(0)
  })
})

describe('T17 — /__e2e/wa/emit', () => {
  it('AC-T17-04 message.inbound válido é entregue ao consumidor do worker (observável em /__e2e/wa/deliveries)', async () => {
    const msgId = `t17-${randomBytes(4).toString('hex')}`
    const emit = await http(serve.info.apiUrl, 'POST', '/__e2e/wa/emit', { event: inboundEvent('sessao-t17', msgId) })
    expect(emit.status, emit.text).toBe(202)
    const streamId = emit.body.stream_id
    expect(typeof streamId).toBe('string')

    const d = await http(serve.info.apiUrl, 'GET', `/__e2e/wa/deliveries?stream_id=${encodeURIComponent(streamId)}&wait_ms=10000`)
    expect(d.status, d.text).toBe(200)
    expect(d.body.group).toBe('crm')
    expect(d.body.delivered, d.text).toBe(true)
    expect(d.body.acked, d.text).toBe(true)
    const handled = d.body.handled.find((h: any) => h.stream_id === streamId)
    expect(handled, `worker não entregou aos handlers: ${d.text}`).toBeTruthy()
    expect(handled.type).toBe('message.inbound')
  })

  it('AC-T17-04 evento inválido → 422 e nada é publicado', async () => {
    const len = await redis.xlen('wsm:events')
    const bad = await http(serve.info.apiUrl, 'POST', '/__e2e/wa/emit', { event: { v: 1, type: 'message.inbound', session_id: 's', at: 'ontem' } })
    expect(bad.status, bad.text).toBe(422)
    expect(await redis.xlen('wsm:events')).toBe(len)
  })
})

describe('T17 — encerramento', () => {
  it('AC-T17-01 ao encerrar (q no stdin), sai com exit 0 e o banco descartável é removido', async () => {
    const name = serve.info.database
    await e2eDb?.$client.end().catch(() => {})
    e2eDb = undefined
    const res = await serve.stop(30_000)
    stopped = true
    expect(res, `serve.mjs não encerrou:\n${serve.output()}`).not.toBeNull()
    expect(res!.code, serve.output()).toBe(0)
    expect(await dbExists(name), `banco ${name} ainda existe`).toBe(false)
  }, 60_000)
})
