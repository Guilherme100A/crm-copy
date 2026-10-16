import { describe, expect, it, vi } from 'vitest'
import { decide, isPublicPath } from '@/app/guard'
import { HttpError } from '@/lib/http'
import { authApi, fieldMessage, publicRequest } from './api'
import { invitationPath, isExpired } from './invitation-page'
import { passwordProblem, passwordStrength } from './password'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('passwordStrength / passwordProblem', () => {
  it.each([
    ['', 0, 'weak'],
    ['abc12', 1, 'weak'],
    ['abcdef', 2, 'medium'],
    ['abcdefghi', 3, 'medium'],
    ['abcdefghij', 3, 'strong'],
    ['abcdefghijkl', 4, 'strong'],
    ['a'.repeat(40), 4, 'strong'],
  ])('%j → nível %i, %s', (pw, level, label) => {
    expect(passwordStrength(pw)).toEqual({ level, label })
  })

  it('confirmação diferente vem antes do tamanho; mínimo de 8', () => {
    expect(passwordProblem('12345678', '12345679')).toBe('mismatch')
    expect(passwordProblem('1234567', '1234567')).toBe('tooShort')
    expect(passwordProblem('12345678', '12345678')).toBeNull()
  })
})

describe('publicRequest', () => {
  it('envia JSON same-origin com o header CSRF e devolve o corpo', async () => {
    const fetchFn = vi.fn(async () => json(200, { ok: true }))
    await expect(publicRequest('POST', '/api/x', { a: 1 }, fetchFn as never)).resolves.toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledWith('/api/x', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'crm', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    })
  })

  it('401 vira HttpError sem sondar a sessão nem navegar (credencial errada no login)', async () => {
    const fetchFn = vi.fn(async () => json(401, { error: { code: 'UNAUTHORIZED', message: 'Credenciais inválidas' } }))
    const err = await publicRequest('POST', '/api/auth/login', {}, fetchFn as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('corpo não-JSON em 5xx → INTERNAL', async () => {
    const fetchFn = vi.fn(async () => new Response('bad gateway', { status: 502 }))
    await expect(publicRequest('GET', '/api/x', undefined, fetchFn as never)).rejects.toMatchObject({ code: 'INTERNAL', status: 502 })
  })

  it('tokens vão codificados na URL', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { valid: false, reason: 'used' }))
    await expect(authApi.checkReset('a/b c')).resolves.toEqual({ valid: false, reason: 'used' })
    expect(spy.mock.calls[0]![0]).toBe('/api/auth/password-resets/a%2Fb%20c')
    spy.mockRestore()
  })
})

describe('fieldMessage', () => {
  const err = new HttpError(422, 'VALIDATION_ERROR', 'Dados inválidos', { fields: [{ path: 'email', message: 'E-mail inválido' }, { path: 'password', message: 'Curta' }] })
  it('primeiro campo ou o pedido', () => {
    expect(fieldMessage(err)).toBe('E-mail inválido')
    expect(fieldMessage(err, 'password')).toBe('Curta')
    expect(fieldMessage(new HttpError(409, 'CONFLICT', 'x'))).toBeNull()
  })
})

describe('guarda das rotas públicas', () => {
  it.each(['/login', '/register', '/cadastro', '/forgot-password', '/reset-password', '/invitations/abc', '/invitation/abc'])('%s é pública', (p) => {
    expect(isPublicPath(p)).toBe(true)
    expect(decide(null, p, p)).toEqual({ kind: 'allow' })
  })

  it('o resto continua protegido', () => {
    expect(isPublicPath('/invitations')).toBe(false)
    expect(isPublicPath('/profile')).toBe(false)
    expect(decide(null, '/profile', '/profile?tab=security')).toEqual({ kind: 'redirect', href: '/login?redirect=%2Fprofile%3Ftab%3Dsecurity', denied: false })
  })
})

describe('convite', () => {
  it('expirado por status ou pela data', () => {
    const now = Date.parse('2026-10-16T12:00:00Z')
    expect(isExpired({ status: 'pending', expires_at: '2026-10-17T00:00:00Z' }, now)).toBe(false)
    expect(isExpired({ status: 'pending', expires_at: '2026-10-16T11:00:00Z' }, now)).toBe(true)
    expect(isExpired({ status: 'expired', expires_at: '2026-10-17T00:00:00Z' }, now)).toBe(true)
    expect(isExpired({ status: 'accepted', expires_at: '2026-10-16T11:00:00Z' }, now)).toBe(false)
  })

  it('caminho de retorno do login', () => {
    expect(invitationPath('t/1')).toBe('/invitations/t%2F1')
  })
})
