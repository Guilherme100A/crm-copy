import { describe, expect, it } from 'vitest'
import { HttpError } from '@/lib/http'
import { isEmail, MAX_RESENDS_PER_DAY, resendBlock, resendErrorKind } from './invitations'

describe('reenvio de convite (AC-T54-04)', () => {
  it('sem reenvios hoje → "limite"; intervalo mínimo → "aguarde"; liberado → nada', () => {
    expect(MAX_RESENDS_PER_DAY).toBe(3)
    expect(resendBlock({ status: 'pending', can_resend: false, resends_remaining_today: 0 })).toBe('limit')
    expect(resendBlock({ status: 'pending', can_resend: false, resends_remaining_today: 2 })).toBe('cooldown')
    expect(resendBlock({ status: 'pending', can_resend: true, resends_remaining_today: 1 })).toBeNull()
    expect(resendBlock({ status: 'accepted', can_resend: false, resends_remaining_today: 0 })).toBeNull()
  })

  it('429 resend_limit → limite; resend_cooldown → aguarde; outros erros → null', () => {
    expect(resendErrorKind(new HttpError(429, 'RATE_LIMIT', 'x', { error_code: 'resend_limit' }))).toBe('limit')
    expect(resendErrorKind(new HttpError(429, 'RATE_LIMIT', 'x', { error_code: 'resend_cooldown' }))).toBe('cooldown')
    expect(resendErrorKind(new HttpError(429, 'RATE_LIMIT', 'x'))).toBe('limit')
    expect(resendErrorKind(new HttpError(409, 'CONFLICT', 'x'))).toBeNull()
    expect(resendErrorKind(new Error('x'))).toBeNull()
  })

  it('e-mail do convite segue a regex do formulário', () => {
    expect(isEmail(' a@b.co ')).toBe(true)
    expect(isEmail('a@b')).toBe(false)
    expect(isEmail('a b@c.d')).toBe(false)
  })
})
