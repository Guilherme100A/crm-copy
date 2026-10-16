// AC-T117-01/02 — logout e reset de senha encerram os streams SSE da sessão/usuário em < 2 s (heartbeat padrão de 20 s).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { envelopeOf, sleep, summary, type SseConnection } from '../helpers/sse'
import { call, endedWithin, type Env, login, openStream, register, resetToken, startEnv } from './setup'

let env: Env
const open: SseConnection[] = []
const track = (c: SseConnection) => (open.push(c), c)

beforeAll(async () => {
  env = await startEnv()
})
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})
afterAll(async () => {
  await env?.close()
})

const named = (name: string) => (m: { event: string; data: string }) => m.event === 'company.updated' && envelopeOf(m as never).data?.name === name

describe('T117 — logout encerra o SSE', () => {
  it('AC-T117-01 POST /api/auth/logout fecha o stream SSE da mesma sessão em < 2 s', async () => {
    const acc = await register(env.fetcher)
    const cookie = await login(env.fetcher, acc)
    const s = track(await openStream(env.fetcher, cookie, acc.companyId))
    expect(s.isEnded()).toBe(false)

    const out = await call(env.fetcher, 'POST', '/api/auth/logout', {}, cookie)
    expect(out.status, out.text).toBeGreaterThanOrEqual(200)
    expect(out.status).toBeLessThan(300)
    const t0 = Date.now()
    const took = await endedWithin(s, t0, 2_000)
    expect(took, `stream ainda aberto após logout; recebidas: ${summary(s.messages)}`).toBeLessThan(2_000)
  })

  it('AC-T117-01 outra sessão do mesmo usuário continua aberta e recebendo eventos', async () => {
    const acc = await register(env.fetcher)
    const cookieA = await login(env.fetcher, acc)
    const cookieB = await login(env.fetcher, acc)
    const sa = track(await openStream(env.fetcher, cookieA, acc.companyId))
    const sb = track(await openStream(env.fetcher, cookieB, acc.companyId))

    expect((await call(env.fetcher, 'POST', '/api/auth/logout', {}, cookieA)).status).toBeLessThan(300)
    const took = await endedWithin(sa, Date.now(), 2_000)
    expect(took, 'stream da sessão deslogada não fechou').toBeLessThan(2_000)

    await env.publisher.publish(acc.companyId, 'company.updated', { name: 'apos-logout-t117' })
    await sb.waitFor(named('apos-logout-t117'), 5_000)
    expect(sb.isEnded()).toBe(false)
    // a sessão B segue autenticada
    expect((await call(env.fetcher, 'GET', '/api/auth/profile', undefined, cookieB)).status).toBe(200)
  })

  it('AC-T117-01 todos os streams abertos pela sessão deslogada fecham (duas abas)', async () => {
    const acc = await register(env.fetcher)
    const cookie = await login(env.fetcher, acc)
    const s1 = track(await openStream(env.fetcher, cookie, acc.companyId))
    const s2 = track(await openStream(env.fetcher, cookie, acc.companyId))
    await call(env.fetcher, 'POST', '/api/auth/logout', {}, cookie)
    const t0 = Date.now()
    expect(await endedWithin(s1, t0, 2_000)).toBeLessThan(2_000)
    expect(await endedWithin(s2, t0, 2_000)).toBeLessThan(2_000)
  })
})

describe('T117 — reset de senha encerra os SSE do usuário', () => {
  it('AC-T117-02 PATCH /api/auth/password-resets/:token fecha em < 2 s todos os streams do usuário', async () => {
    const acc = await register(env.fetcher)
    const cookieA = await login(env.fetcher, acc)
    const cookieB = await login(env.fetcher, acc)
    const sa = track(await openStream(env.fetcher, cookieA, acc.companyId))
    const sb = track(await openStream(env.fetcher, cookieB, acc.companyId))

    expect((await call(env.fetcher, 'POST', '/api/auth/password-resets', { email: acc.email })).status).toBe(200)
    const token = resetToken(env.mailer, acc.email)
    const pwd = `Nova-${Date.now()}-senha`
    const res = await call(env.fetcher, 'PATCH', `/api/auth/password-resets/${encodeURIComponent(token)}`, { password: pwd, password_confirmation: pwd })
    expect(res.status, res.text).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)

    const t0 = Date.now()
    const [ta, tb] = await Promise.all([endedWithin(sa, t0, 2_000), endedWithin(sb, t0, 2_000)])
    expect(ta, `stream A aberto; ${summary(sa.messages)}`).toBeLessThan(2_000)
    expect(tb, `stream B aberto; ${summary(sb.messages)}`).toBeLessThan(2_000)
  })

  it('AC-T117-02 streams de outro usuário da mesma empresa não são afetados', async () => {
    const acc = await register(env.fetcher)
    const other = await register(env.fetcher)
    const mine = track(await openStream(env.fetcher, await login(env.fetcher, acc), acc.companyId))
    const theirs = track(await openStream(env.fetcher, await login(env.fetcher, other), other.companyId))

    await call(env.fetcher, 'POST', '/api/auth/password-resets', { email: acc.email })
    const pwd = `Nova-${Date.now()}-senha`
    const res = await call(env.fetcher, 'PATCH', `/api/auth/password-resets/${encodeURIComponent(resetToken(env.mailer, acc.email))}`, {
      password: pwd,
      password_confirmation: pwd,
    })
    expect(res.status, res.text).toBeLessThan(300)
    expect(await endedWithin(mine, Date.now(), 2_000)).toBeLessThan(2_000)

    await sleep(300)
    expect(theirs.isEnded()).toBe(false)
    await env.publisher.publish(other.companyId, 'company.updated', { name: 'outro-usuario-t117' })
    await theirs.waitFor(named('outro-usuario-t117'), 5_000)
  })
})
