import { describe, expect, it } from 'vitest'
import { signSsoToken, SsoTokenError, verifySsoToken } from './sso-token'

const SECRET = 'test-secret-0123456789abcdef0123456789'
const NOW = 1_800_000_000
const base = () => ({
  iss: 'ai-manager',
  aud: 'crm',
  sub: 'ai-manager:admin',
  name: 'admin',
  email: 'admin@ai-manager.local',
  iat: NOW,
  exp: NOW + 120,
  jti: 'jti-1',
})

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof SsoTokenError ? err.code : 'other'
  }
  return 'ok'
}

describe('verifySsoToken', () => {
  it('aceita o token do contrato e devolve as claims', () => {
    const c = verifySsoToken(signSsoToken(base(), SECRET), SECRET, { nowSec: NOW + 5 })
    expect(c).toMatchObject({ sub: 'ai-manager:admin', email: 'admin@ai-manager.local', name: 'admin', jti: 'jti-1' })
  })

  it('aud como lista contendo crm vale', () => {
    expect(codeOf(() => verifySsoToken(signSsoToken({ ...base(), aud: ['x', 'crm'] }, SECRET), SECRET, { nowSec: NOW }))).toBe('ok')
  })

  it.each([
    ['assinatura com outro segredo', () => signSsoToken(base(), 'outro'), 'bad_signature'],
    ['alg none', () => signSsoToken(base(), SECRET, { alg: 'none' }), 'bad_alg'],
    ['alg HS512', () => signSsoToken(base(), SECRET, { alg: 'HS512' }), 'bad_alg'],
    ['iss errado', () => signSsoToken({ ...base(), iss: 'x' }, SECRET), 'bad_issuer'],
    ['aud errada', () => signSsoToken({ ...base(), aud: 'web' }, SECRET), 'bad_audience'],
    ['expirado além da tolerância', () => signSsoToken({ ...base(), iat: NOW - 200, exp: NOW - 31 }, SECRET), 'expired'],
    ['emitido no futuro', () => signSsoToken({ ...base(), iat: NOW + 60, exp: NOW + 180 }, SECRET), 'not_yet_valid'],
    ['vida longa demais', () => signSsoToken({ ...base(), exp: NOW + 3600 }, SECRET), 'bad_claims'],
    ['sem jti', () => signSsoToken({ ...base(), jti: '' }, SECRET), 'bad_claims'],
    ['sub sem o prefixo', () => signSsoToken({ ...base(), sub: 'admin' }, SECRET), 'bad_claims'],
    ['email inválido', () => signSsoToken({ ...base(), email: 'nope' }, SECRET), 'bad_claims'],
    ['malformado', () => 'a.b', 'malformed'],
  ])('%s → %s', (_name, make, code) => {
    expect(codeOf(() => verifySsoToken(make(), SECRET, { nowSec: NOW }))).toBe(code)
  })

  it('assinatura adulterada (payload trocado) é recusada', () => {
    const [h, , s] = signSsoToken(base(), SECRET).split('.')
    const p = Buffer.from(JSON.stringify({ ...base(), email: 'root@ai-manager.local' })).toString('base64url')
    expect(codeOf(() => verifySsoToken(`${h}.${p}.${s}`, SECRET, { nowSec: NOW }))).toBe('bad_signature')
  })

  it('sem segredo nada passa', () => {
    expect(codeOf(() => verifySsoToken(signSsoToken(base(), ''), '', { nowSec: NOW }))).toBe('bad_signature')
  })
})
