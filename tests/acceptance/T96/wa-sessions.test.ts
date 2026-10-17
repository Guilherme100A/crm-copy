// AC-T96-03 pela API: GET /api/admin/wa/sessions lista as sessões de todas as empresas pelo WaGateway (FakeWaGateway)
// com estado e empresa dona (crm.connections.session_id); perfil ai-manager (modo extensão) → 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { owner, platformAdmin, startEnv, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
let admin: User
let a: User
let b: User
let connA: Any
let connB: Any

beforeAll(async () => {
  const wa = new FakeWaGateway({ sessions: [{ id: 'orfa-t96', name: 'Órfã', phone: '+5511900000096', state: 'PAUSED' }] })
  env = await startEnv({ wa, extra: { waProfile: 'crm' } })
  admin = await platformAdmin(env)
  a = await owner(env)
  b = await owner(env)
  const ra = await a.c.post('/api/connections', { name: 'Loja A' })
  expect(ra.status, ra.text).toBeLessThan(300)
  const rb = await b.c.post('/api/connections', { name: 'Loja B' })
  expect(rb.status, rb.text).toBeLessThan(300)
  ;[connA] = await env.q(`SELECT id, session_id FROM crm.connections WHERE company_id = $1`, [a.companyId])
  ;[connB] = await env.q(`SELECT id, session_id FROM crm.connections WHERE company_id = $1`, [b.companyId])
}, 120_000)

afterAll(async () => {
  await env?.close()
})

const companyName = async (id: string) => (await env.q(`SELECT name FROM crm.companies WHERE id = $1`, [id]))[0].name

describe('T96 — sessões WhatsApp no admin (AC-T96-03)', () => {
  it('AC-T96-03 perfil crm: lista sessões de todas as empresas com estado e empresa dona; órfã → company null', async () => {
    const r = await admin.c.get('/api/admin/wa/sessions')
    expect(r.status, r.text).toBe(200)
    expect(r.body.profile).toBe('crm')
    expect(r.body.total).toBe(3)
    const byId = new Map<string, Any>(r.body.items.map((s: Any) => [s.id, s]))
    const gw = new Map((await env.wa.sessions.list()).map((s) => [s.id, s]))

    const sa = byId.get(connA.session_id)
    expect(sa).toBeTruthy()
    expect(sa.state).toBe(gw.get(connA.session_id)!.state)
    expect(sa.company).toMatchObject({ id: a.companyId, name: await companyName(a.companyId) })
    expect(sa.connection).toMatchObject({ id: connA.id, name: 'Loja A' })

    const sb = byId.get(connB.session_id)
    expect(sb.company).toMatchObject({ id: b.companyId, name: await companyName(b.companyId) })
    expect(sb.connection).toMatchObject({ id: connB.id, name: 'Loja B' })

    const orphan = byId.get('orfa-t96')
    expect(orphan).toMatchObject({ id: 'orfa-t96', name: 'Órfã', phone: '+5511900000096', state: 'PAUSED', company: null, connection: null })
  })

  it('AC-T96-03 o estado reflete o gateway e os filtros company_id, state e orphan funcionam', async () => {
    await env.wa.sessions.pause(connB.session_id).catch(() => {})
    const gwState = (await env.wa.sessions.get(connB.session_id)).state
    const all = await admin.c.get('/api/admin/wa/sessions')
    expect(all.body.items.find((s: Any) => s.id === connB.session_id).state).toBe(gwState)

    const onlyA = await admin.c.get(`/api/admin/wa/sessions?company_id=${a.companyId}`)
    expect(onlyA.status).toBe(200)
    expect(onlyA.body.items.map((s: Any) => s.id)).toEqual([connA.session_id])

    const orphans = await admin.c.get('/api/admin/wa/sessions?orphan=1')
    expect(orphans.body.items.map((s: Any) => s.id)).toEqual(['orfa-t96'])

    const paused = await admin.c.get('/api/admin/wa/sessions?state=PAUSED')
    expect(paused.body.items.every((s: Any) => s.state === 'PAUSED')).toBe(true)
    expect(paused.body.items.map((s: Any) => s.id)).toContain('orfa-t96')
  })

  it('AC-T96-03 só platform_admin: dono → 403, sem sessão → 401', async () => {
    expect((await a.c.get('/api/admin/wa/sessions')).status).toBe(403)
    expect((await env.app.request('/api/admin/wa/sessions')).status).toBe(401)
  })

  it('AC-T96-03 modo extensão (waProfile ai-manager) → 404 e o gateway não é consultado; o resto do admin segue', async () => {
    let listed = 0
    const spy = new FakeWaGateway({ sessions: [{ id: 'x' }] })
    const orig = spy.sessions.list.bind(spy.sessions)
    spy.sessions.list = async () => {
      listed++
      return orig()
    }
    const app = env.makeApp({ waGateway: spy, waProfile: 'ai-manager' })
    const u = await platformAdmin(env, app)
    const r = await u.c.get('/api/admin/wa/sessions')
    expect(r.status).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('"x"')
    expect(listed).toBe(0)
    // os dados do CRM continuam no admin
    expect((await u.c.get('/api/admin/announcements')).status).toBe(200)
  })

  it('AC-T96-03 sem waProfile injetado vale WA_RPC_PROFILE do ambiente (ai-manager → 404; crm → 200)', async () => {
    const saved = process.env.WA_RPC_PROFILE
    try {
      process.env.WA_RPC_PROFILE = 'ai-manager'
      const appExt = env.makeApp({ waProfile: undefined })
      const u1 = await platformAdmin(env, appExt)
      expect((await u1.c.get('/api/admin/wa/sessions')).status).toBe(404)

      process.env.WA_RPC_PROFILE = 'crm'
      const appCrm = env.makeApp({ waProfile: undefined })
      const u2 = await platformAdmin(env, appCrm)
      const r = await u2.c.get('/api/admin/wa/sessions')
      expect(r.status).toBe(200)
      expect(r.body.profile).toBe('crm')
    } finally {
      if (saved === undefined) delete process.env.WA_RPC_PROFILE
      else process.env.WA_RPC_PROFILE = saved
    }
  })

  it('AC-T96-03 gateway que falha → erro claro (5xx não-500), sem vazar detalhes', async () => {
    const broken = new FakeWaGateway()
    broken.sessions.list = async () => {
      throw new Error('ECONNREFUSED segredo-interno')
    }
    const app = env.makeApp({ waGateway: broken, waProfile: 'crm' })
    const u = await platformAdmin(env, app)
    const r = await u.c.get('/api/admin/wa/sessions')
    expect(r.status).toBeGreaterThanOrEqual(502)
    expect(r.status).toBeLessThan(600)
    expect(r.text).not.toContain('segredo-interno')
  })
})
