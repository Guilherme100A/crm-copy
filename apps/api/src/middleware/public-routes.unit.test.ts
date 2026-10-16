import { describe, expect, it } from 'vitest'
import { isInboundHook, isPublicApiRoute } from './public-routes'

describe('rotas públicas (SPEC 3.6)', () => {
  it('reconhece as públicas', () => {
    expect(isPublicApiRoute('POST', '/api/auth/login')).toBe(true)
    expect(isPublicApiRoute('POST', '/api/auth/login/')).toBe(true)
    expect(isPublicApiRoute('POST', '/api/auth/register')).toBe(true)
    expect(isPublicApiRoute('POST', '/api/auth/password-resets/abc')).toBe(true)
    expect(isPublicApiRoute('GET', '/api/invitations/tok')).toBe(true)
    expect(isPublicApiRoute('POST', '/api/hooks/a/b')).toBe(true)
  })

  it('o resto exige sessão', () => {
    expect(isPublicApiRoute('GET', '/api/auth/login')).toBe(false)
    expect(isPublicApiRoute('POST', '/api/auth/logout')).toBe(false)
    expect(isPublicApiRoute('GET', '/api/invitations')).toBe(false)
    expect(isPublicApiRoute('DELETE', '/api/invitations/tok')).toBe(false)
    expect(isPublicApiRoute('POST', '/api/hooksx')).toBe(false)
  })

  it('extras e hooks', () => {
    expect(isPublicApiRoute('GET', '/api/x', [{ method: '*', path: '/api/x' }])).toBe(true)
    expect(isInboundHook('/api/hooks/1')).toBe(true)
    expect(isInboundHook('/api/contacts')).toBe(false)
  })
})
