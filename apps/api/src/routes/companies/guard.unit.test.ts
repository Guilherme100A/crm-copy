import { describe, expect, it } from 'vitest'
import { TeamError } from '@crm/core'
import { ApiError } from '../../lib/errors'
import { toApi } from '../team/support'
import { isCompanyInactiveExempt } from './guard'

describe('empresa inativa: rotas liberadas', () => {
  it('auth, listar/criar/ler/editar/desativar empresas, trocar e sair', () => {
    const ok: Array<[string, string]> = [
      ['POST', '/api/auth/logout'],
      ['GET', '/api/auth/profile'],
      ['GET', '/api/companies'],
      ['POST', '/api/companies'],
      ['GET', '/api/companies/abc'],
      ['PUT', '/api/companies/abc'],
      ['DELETE', '/api/companies/abc'],
      ['POST', '/api/companies/abc/switch'],
      ['POST', '/api/companies/abc/leave'],
    ]
    for (const [m, p] of ok) expect(isCompanyInactiveExempt(m, p), `${m} ${p}`).toBe(true)
  })

  it('o resto da API fica bloqueado', () => {
    const blocked: Array<[string, string]> = [
      ['GET', '/api/team'],
      ['POST', '/api/team/invitations'],
      ['PATCH', '/api/companies/abc'],
      ['POST', '/api/companies/abc/other'],
      ['GET', '/api/events'],
      ['GET', '/api/authx'],
    ]
    for (const [m, p] of blocked) expect(isCompanyInactiveExempt(m, p), `${m} ${p}`).toBe(false)
  })
})

describe('TeamError → ApiError', () => {
  it('mapeia o tipo para o código da SPEC 3.5 e põe error_code em details', () => {
    const e = toApi(new TeamError('rate_limit', 'limite', 'resend_limit', { resends_remaining_today: 0 })) as ApiError
    expect(e).toBeInstanceOf(ApiError)
    expect([e.code, e.status]).toEqual(['RATE_LIMIT', 429])
    expect(e.details).toEqual({ resends_remaining_today: 0, error_code: 'resend_limit' })
    expect((toApi(new TeamError('gone', 'x')) as ApiError).status).toBe(410)
    expect((toApi(new TeamError('not_found', 'x')) as ApiError).details).toBeUndefined()
    const other = new Error('x')
    expect(toApi(other)).toBe(other)
  })
})
