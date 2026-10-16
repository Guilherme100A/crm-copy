import { describe, expect, it } from 'vitest'
import type { CompanyDto } from './api'
import {
  canEditTimeZone,
  COMPANY_TIME_ZONES,
  companyFormErrors,
  companyPayload,
  formFromCompany,
  resolveCompanyTab,
} from './company'

const company: CompanyDto = {
  id: 'c1',
  name: 'Acme',
  slug: 'acme',
  description: null,
  active: true,
  time_zone: 'America/Sao_Paulo',
  connection_status_emails_enabled: true,
  deactivated_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  role: 'owner',
}

describe('dados da empresa (AC-T53-01)', () => {
  it('nome vazio (ou só espaços) bloqueia o salvar; slug segue o formato do servidor', () => {
    const f = formFromCompany(company)
    expect(companyFormErrors(f)).toEqual({})
    expect(companyFormErrors({ ...f, name: '   ' })).toEqual({ name: 'required' })
    expect(companyFormErrors({ ...f, slug: 'Acme Corp' })).toEqual({ slug: 'slug' })
    expect(companyFormErrors({ ...f, slug: 'a' })).toEqual({ slug: 'slug' })
    expect(companyFormErrors({ ...f, slug: 'acme-2' })).toEqual({})
    expect(companyFormErrors({ ...f, slug: '' })).toEqual({})
  })

  it('fuso só para owner/admin (ou admin da plataforma); os 12 fusos do servidor', () => {
    expect(canEditTimeZone('owner', false)).toBe(true)
    expect(canEditTimeZone('admin', false)).toBe(true)
    expect(canEditTimeZone('member', false)).toBe(false)
    expect(canEditTimeZone('member', true)).toBe(true)
    expect(COMPANY_TIME_ZONES).toHaveLength(12)
    expect(COMPANY_TIME_ZONES[0]).toBe('America/Sao_Paulo')
  })

  it('PUT só com o que mudou; fuso fica fora quando o papel não pode alterá-lo', () => {
    const f = { ...formFromCompany(company), name: ' Acme 2 ', description: '  ', time_zone: 'UTC' }
    expect(companyPayload(company, f, true)).toEqual({ name: 'Acme 2', time_zone: 'UTC' })
    expect(companyPayload(company, f, false)).toEqual({ name: 'Acme 2' })
    expect(companyPayload({ ...company, description: 'x' }, { ...f, description: '' }, false)).toEqual({
      name: 'Acme 2',
      description: null,
    })
    expect(
      companyPayload(company, { ...formFromCompany(company), connection_status_emails_enabled: false }, true),
    ).toEqual({
      connection_status_emails_enabled: false,
    })
  })
})

describe('sub-abas da Empresa (AC-T53-05)', () => {
  it('sub-aba inválida ou sem permissão vira a primeira permitida', () => {
    expect(resolveCompanyTab('hours', ['info', 'departments', 'hours'])).toBe('hours')
    expect(resolveCompanyTab('nope', ['info', 'departments', 'hours'])).toBe('info')
    expect(resolveCompanyTab(undefined, ['info', 'hours'])).toBe('info')
    expect(resolveCompanyTab('departments', ['info', 'hours'])).toBe('info')
    expect(resolveCompanyTab('info', [])).toBeNull()
  })
})
