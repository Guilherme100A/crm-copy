// AC-T23-06 (achado na T102): depois que a sonda deu a sessão como morta, os 401 das queries da tela que está saindo
// (disparadas depois do redirect ao login) não fazem uma 2ª sonda; uma resposta OK (o login) libera a sonda de novo.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, configureHttp, PROFILE_PATH } from './http'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthorized = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } })

describe('401 → uma sonda só', () => {
  afterEach(() => configureHttp({ fetch: (i, init) => fetch(i, init), onUnauthorized: () => undefined }))

  it('rodada seguinte de 401 depois do redirect não sonda de novo; depois do login, sonda', async () => {
    let probes = 0
    let loggedIn = false
    const login = vi.fn()
    configureHttp({
      onUnauthorized: login,
      fetch: async (url, init) => {
        if (url === PROFILE_PATH && init.method === 'GET') {
          probes++
          return unauthorized()
        }
        if (url === '/api/auth/login') {
          loggedIn = true
          return json(200, { ok: true })
        }
        return loggedIn ? json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }) : unauthorized()
      },
    })

    await expect(api.put(PROFILE_PATH, { locale: 'en' })).rejects.toMatchObject({ status: 401 })
    expect(probes).toBe(1)
    expect(login).toHaveBeenCalledTimes(1)

    // a sonda é liberada no próximo tick; as queries da tela antiga chegam depois
    await new Promise((r) => setTimeout(r, 5))
    await Promise.allSettled([api.get('/api/chats'), api.get('/api/connections')])
    expect(probes).toBe(1)

    await api.post('/api/auth/login', { email: 'a', password: 'b' })
    await expect(api.get('/api/chats')).rejects.toMatchObject({ status: 401 })
    expect(probes).toBe(2)
  })
})
