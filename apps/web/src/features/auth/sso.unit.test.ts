import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'
import { authApi } from './api'
import { exchangeOnce, readSsoHash, ssoErrorKey } from './sso'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('readSsoHash', () => {
  it('lê o token do hash', () => {
    expect(readSsoHash('#token=abc.def.ghi')).toEqual({ token: 'abc.def.ghi', redirect: null })
  })

  it('aceita redirect interno seguro e recusa externo', () => {
    expect(readSsoHash('#token=t&redirect=%2Fchats').redirect).toBe('/chats')
    expect(readSsoHash('#token=t&redirect=https%3A%2F%2Fevil.com').redirect).toBeNull()
    expect(readSsoHash('#token=t&redirect=%2F%2Fevil.com').redirect).toBeNull()
  })

  it('sem token (ou vazio) → null', () => {
    expect(readSsoHash('').token).toBeNull()
    expect(readSsoHash('#token=').token).toBeNull()
    expect(readSsoHash('#other=1').token).toBeNull()
  })
})

describe('exchangeOnce', () => {
  it('o mesmo token é trocado uma vez só (StrictMode)', async () => {
    const fn = vi.fn(async (t: string) => ({ t }))
    const a = exchangeOnce('tok-1', fn)
    const b = exchangeOnce('tok-1', fn)
    expect(a).toBe(b)
    await expect(a).resolves.toEqual({ t: 'tok-1' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('ssoErrorKey', () => {
  it('404/501 = desligado; 4xx = inválido; resto = genérico', () => {
    expect(ssoErrorKey(new HttpError(404, 'NOT_FOUND', ''))).toBe('sso.disabled')
    expect(ssoErrorKey(new HttpError(501, 'X', ''))).toBe('sso.disabled')
    expect(ssoErrorKey(new HttpError(401, 'UNAUTHORIZED', ''))).toBe('sso.invalid')
    expect(ssoErrorKey(new HttpError(500, 'INTERNAL', ''))).toBe('errors.generic')
    expect(ssoErrorKey(new Error('x'))).toBe('errors.generic')
  })
})

describe('authApi.sso', () => {
  it('POST /api/auth/sso { token } com o header CSRF', async () => {
    const fetchFn = vi.fn(async () => json(200, { user: { id: 'u' }, companies: [] }))
    vi.stubGlobal('fetch', fetchFn)
    try {
      await authApi.sso('jwt')
      expect(fetchFn).toHaveBeenCalledWith('/api/auth/sso', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-Requested-With': 'crm', 'Content-Type': 'application/json' },
        body: '{"token":"jwt"}',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
