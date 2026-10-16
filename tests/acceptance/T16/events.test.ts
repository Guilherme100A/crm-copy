// AC-T16-01..04: isolamento por empresa, escopo, replay por Last-Event-ID, heartbeat e logout.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { appFetcher, openStream, seedMember, startEnv, updated, addMember, type Env } from './setup'
import { connectSse, envelopeOf, sleep, summary, type SseConnection } from './sse'

let env: Env
let app: any
let fast: any
const open: SseConnection[] = []
const track = (c: SseConnection) => (open.push(c), c)

beforeAll(async () => {
  env = await startEnv()
  app = env.makeApp()
  fast = env.makeApp({ heartbeatMs: 1000 })
})

afterEach(async () => {
  while (open.length) await open.pop()!.close()
  env.core.clearScopeFilters?.()
})

afterAll(async () => {
  await env?.close()
})

const stream = async (m: { token: string; companyId: string }, opts: { lastEventId?: string; query?: string } = {}, a = app) =>
  track(await openStream(appFetcher(a), m, opts))

const byName = (name: string) => (m: { event: string; data: string }) => m.event === 'company.updated' && envelopeOf(m as any).data?.name === name

describe('AC-T16-01 isolamento por empresa', () => {
  it('AC-T16-01 usuário da empresa A não recebe evento publicado para a empresa B', async () => {
    const a = await seedMember(env, 'owner')
    const b = await seedMember(env, 'owner')
    const sa = await stream(a)
    const sb = await stream(b)

    const id = await env.publisher.publish(b.companyId, 'company.updated', updated('so-para-B'))
    expect(typeof id).toBe('string')
    const got = await sb.waitFor(byName('so-para-B'))
    const env1 = envelopeOf(got)
    expect(env1).toMatchObject({ id, type: 'company.updated', company_id: b.companyId, data: { name: 'so-para-B' } })
    expect(got.id).toBe(id)
    expect(typeof env1.at).toBe('string')

    // A recebe o evento da própria empresa, mas nunca o de B
    await env.publisher.publish(a.companyId, 'company.updated', updated('so-para-A'))
    await sa.waitFor(byName('so-para-A'))
    await sleep(300)
    expect(sa.events().map((m) => envelopeOf(m).company_id), summary(sa.messages)).toEqual([a.companyId])
    expect(sb.events().some(byName('so-para-A'))).toBe(false)
  })

  it('AC-T16-01 usuário membro de A e B só recebe eventos da empresa do stream', async () => {
    const a = await seedMember(env, 'owner')
    const b = await seedMember(env, 'owner')
    await addMember(env, b.companyId, a.userId, 'member')
    const sa = await stream(a) // company_id = A
    await env.publisher.publish(b.companyId, 'company.updated', updated('B-multi'))
    await env.publisher.publish(a.companyId, 'company.updated', updated('A-multi'))
    await sa.waitFor(byName('A-multi'))
    await sleep(300)
    expect(sa.events().some(byName('B-multi')), summary(sa.messages)).toBe(false)

    const sab = await stream({ token: a.token, companyId: b.companyId })
    await env.publisher.publish(b.companyId, 'company.updated', updated('B-multi-2'))
    await sab.waitFor(byName('B-multi-2'))
  })

  it('AC-T16-01 pedir o stream de uma empresa da qual não é membro → 404; sem sessão → 401', async () => {
    const a = await seedMember(env, 'owner')
    const b = await seedMember(env, 'owner')
    const foreign = track(await connectSse(appFetcher(app), `/api/events?company_id=${b.companyId}`, { cookie: `crm_session=${a.token}` }))
    expect(foreign.status, foreign.text).toBe(404)
    expect(JSON.parse(foreign.text!).error.code).toBe('NOT_FOUND')
    const anon = track(await connectSse(appFetcher(app), `/api/events?company_id=${a.companyId}`))
    expect(anon.status).toBe(401)
  })

  it('AC-T16-01 replay por Last-Event-ID também não vaza eventos de outra empresa', async () => {
    const a = await seedMember(env, 'owner')
    const b = await seedMember(env, 'owner')
    const first = await env.publisher.publish(a.companyId, 'company.updated', updated('A-0'))
    await env.publisher.publish(b.companyId, 'company.updated', updated('B-replay'))
    await env.publisher.publish(a.companyId, 'company.updated', updated('A-1'))
    const s = await stream(a, { lastEventId: first })
    await s.waitFor(byName('A-1'))
    expect(s.events().some(byName('B-replay'))).toBe(false)
  })
})

describe('AC-T16-02 escopo do evento', () => {
  const SCOPE = { connection_id: 'conn-t16-1', department_id: 'dep-t16-1' }

  it('AC-T16-02 evento com scope não chega ao membro fora do escopo e chega ao owner e ao membro dentro', async () => {
    const owner = await seedMember(env, 'owner')
    const inside = await seedMember(env, 'member', owner.companyId)
    const outside = await seedMember(env, 'member', owner.companyId)
    const calls: string[] = []
    env.core.registerScopeFilter((subject: any, scope: any) => {
      if (!scope) return true // evento sem escopo: todos
      calls.push(subject.userId)
      if (subject.userId === inside.userId) return scope?.connection_id === SCOPE.connection_id && scope?.department_id === SCOPE.department_id
      return false
    })

    const so = await stream(owner)
    const si = await stream(inside)
    const sx = await stream(outside)
    await env.publisher.publish(owner.companyId, 'company.updated', updated('escopado'), { scope: SCOPE })
    // marcador sem escopo, publicado depois: quando chega, o escopado já teria chegado
    await env.publisher.publish(owner.companyId, 'company.updated', updated('marcador'))

    await so.waitFor(byName('escopado'))
    await si.waitFor(byName('escopado'))
    await sx.waitFor(byName('marcador'))
    await sleep(200)
    expect(sx.events().some(byName('escopado')), summary(sx.messages)).toBe(false)
    expect(calls, 'owner não deveria passar pelo filtro de escopo').not.toContain(owner.userId)
  })

  it('AC-T16-02 admin também ignora o escopo; membro fora de outro escopo (departamento diferente) não recebe', async () => {
    const owner = await seedMember(env, 'owner')
    const admin = await seedMember(env, 'admin', owner.companyId)
    const member = await seedMember(env, 'member', owner.companyId)
    // membro só enxerga o departamento dep-A
    env.core.registerScopeFilter((subject: any, scope: any) => !scope || subject.userId !== member.userId || scope.department_id === 'dep-A')

    const sa = await stream(admin)
    const sm = await stream(member)
    await env.publisher.publish(owner.companyId, 'company.updated', updated('dep-B'), { scope: { connection_id: 'c1', department_id: 'dep-B' } })
    await env.publisher.publish(owner.companyId, 'company.updated', updated('dep-A'), { scope: { connection_id: 'c1', department_id: 'dep-A' } })
    await sa.waitFor(byName('dep-B'))
    await sa.waitFor(byName('dep-A'))
    await sm.waitFor(byName('dep-A'))
    expect(sm.events().some(byName('dep-B')), summary(sm.messages)).toBe(false)
  })

  it('AC-T16-02 o escopo também vale no replay por Last-Event-ID', async () => {
    const owner = await seedMember(env, 'owner')
    const member = await seedMember(env, 'member', owner.companyId)
    env.core.registerScopeFilter((subject: any, scope: any) => !scope || subject.userId !== member.userId)
    const first = await env.publisher.publish(owner.companyId, 'company.updated', updated('r0'))
    await env.publisher.publish(owner.companyId, 'company.updated', updated('r-escopado'), { scope: SCOPE })
    await env.publisher.publish(owner.companyId, 'company.updated', updated('r-fim'))
    const sm = await stream(member, { lastEventId: first })
    const so = await stream(owner, { lastEventId: first })
    await sm.waitFor(byName('r-fim'))
    await so.waitFor(byName('r-escopado'))
    expect(sm.events().some(byName('r-escopado'))).toBe(false)
  })
})

describe('AC-T16-03 replay por Last-Event-ID', () => {
  it('AC-T16-03 reconectar com Last-Event-ID recebe, em ordem, os eventos publicados durante a desconexão', async () => {
    const m = await seedMember(env, 'owner')
    const s1 = await stream(m)
    const id0 = await env.publisher.publish(m.companyId, 'company.updated', updated('antes'))
    const got = await s1.waitFor(byName('antes'))
    expect(got.id).toBe(id0)
    await s1.close()

    const names = ['d1', 'd2', 'd3', 'd4', 'd5']
    const ids: string[] = []
    for (const n of names) ids.push(await env.publisher.publish(m.companyId, 'company.updated', updated(n)))

    const s2 = await stream(m, { lastEventId: got.id })
    await s2.waitFor(byName('d5'))
    const replayed = s2.events('company.updated')
    expect(replayed.map((x) => envelopeOf(x).data.name), summary(s2.messages)).toEqual(names)
    expect(replayed.map((x) => x.id)).toEqual(ids)

    // ao vivo continua depois do replay
    await env.publisher.publish(m.companyId, 'company.updated', updated('ao-vivo'))
    await s2.waitFor(byName('ao-vivo'))
    expect(s2.events('company.updated').map((x) => envelopeOf(x).data.name)).toEqual([...names, 'ao-vivo'])
  })

  it('AC-T16-03 ?last_event_id= também faz o replay', async () => {
    const m = await seedMember(env, 'owner')
    const id0 = await env.publisher.publish(m.companyId, 'company.updated', updated('q0'))
    await env.publisher.publish(m.companyId, 'company.updated', updated('q1'))
    await env.publisher.publish(m.companyId, 'company.updated', updated('q2'))
    const s = await stream(m, { query: `last_event_id=${encodeURIComponent(id0)}` })
    await s.waitFor(byName('q2'))
    expect(s.events('company.updated').map((x) => envelopeOf(x).data.name)).toEqual(['q1', 'q2'])
  })

  it('AC-T16-03 sem Last-Event-ID não há replay do histórico', async () => {
    const m = await seedMember(env, 'owner')
    await env.publisher.publish(m.companyId, 'company.updated', updated('velho'))
    const s = await stream(m)
    await env.publisher.publish(m.companyId, 'company.updated', updated('novo'))
    await s.waitFor(byName('novo'))
    expect(s.events('company.updated').map((x) => envelopeOf(x).data.name)).toEqual(['novo'])
  })
})

describe('AC-T16-04 heartbeat e logout', () => {
  it('AC-T16-04 sem tráfego o stream envia ping a cada ≤ 20 s (padrão, sem configuração)', async () => {
    const m = await seedMember(env, 'owner')
    const s = await stream(m)
    const firstIdx = s.messages.findIndex((x) => x.event === 'ping')
    const t0 = Date.now()
    const second = await s.waitFor((x) => x.event === 'ping', 21_500, firstIdx + 1)
    expect(second.at - t0).toBeLessThanOrEqual(21_000)
    expect(s.isEnded()).toBe(false)
  }, 60_000)

  it('AC-T16-04 com heartbeat configurado, pings regulares mantêm o stream aberto', async () => {
    const m = await seedMember(env, 'owner')
    const s = await stream(m, {}, fast)
    await sleep(3_600)
    const pings = s.messages.filter((x) => x.event === 'ping')
    expect(pings.length, summary(s.messages)).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < pings.length; i++) expect(pings[i]!.at - pings[i - 1]!.at).toBeLessThanOrEqual(2_000)
    expect(s.isEnded()).toBe(false)
  })

  it('AC-T16-04 logout (publisher.endSession) encerra o stream na hora', async () => {
    const m = await seedMember(env, 'owner')
    const s = await stream(m) // heartbeat padrão de 20 s: o fechamento tem de ser imediato
    await env.sessions.revoke(m.sessionId)
    await env.publisher.endSession(m.sessionId)
    const t0 = Date.now()
    await Promise.race([s.ended, sleep(5_000)])
    expect(s.isEnded(), `stream ainda aberto ${Date.now() - t0} ms após logout`).toBe(true)
  })

  it('AC-T16-04 sessão revogada encerra o stream até o próximo heartbeat', async () => {
    const m = await seedMember(env, 'owner')
    const s = await stream(m, {}, fast)
    await env.sessions.revoke(m.sessionId)
    await Promise.race([s.ended, sleep(4_000)])
    expect(s.isEnded(), 'stream não fechou após revogar a sessão').toBe(true)
  })

  it('AC-T16-04 logout de uma sessão não derruba o stream de outra sessão do mesmo usuário', async () => {
    const m = await seedMember(env, 'owner')
    const other = await env.sessions.create(m.userId, {})
    const s1 = await stream(m)
    const s2 = await stream({ token: other.token, companyId: m.companyId })
    await env.sessions.revoke(m.sessionId)
    await env.publisher.endSession(m.sessionId)
    await Promise.race([s1.ended, sleep(5_000)])
    expect(s1.isEnded()).toBe(true)
    await env.publisher.publish(m.companyId, 'company.updated', updated('ainda-vivo'))
    await s2.waitFor(byName('ainda-vivo'))
    expect(s2.isEnded()).toBe(false)
  })

  it('AC-T16-04 depois do logout o mesmo cookie não reabre o stream (401)', async () => {
    const m = await seedMember(env, 'owner')
    await env.sessions.revoke(m.sessionId)
    const c = track(await connectSse(appFetcher(app), `/api/events?company_id=${m.companyId}`, { cookie: `crm_session=${m.token}` }))
    expect(c.status).toBe(401)
  })
})
