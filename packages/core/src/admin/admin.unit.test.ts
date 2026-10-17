// Regras puras do admin (T95): limites em `settings`, mapeamento de papéis e período das estatísticas.
import { describe, expect, it } from 'vitest'
import { AdminError } from './errors'
import { mergeCompanyLimits, readCompanyLimits, readInboxLimits } from './limits'
import { addStatsDays, resolveStatsPeriod, statsDayIn, statsDays } from './period'
import { legacyRoleOf, resolveSystemRole, systemRoleFromLegacy } from './roles'

describe('limites da empresa (settings.limits)', () => {
  it('ausente, null ou inválido = ilimitado (null); inteiros ≥ 0 valem, inclusive 0', () => {
    expect(readCompanyLimits({})).toEqual({
      connections: null,
      ai_agents: null,
      members: null,
      flows: null,
      webhooks: null,
    })
    expect(readCompanyLimits(null).members).toBeNull()
    expect(
      readCompanyLimits({ limits: { connections: 0, ai_agents: 3, members: -1, flows: 2.5, webhooks: '4' } }),
    ).toEqual({
      connections: 0,
      ai_agents: 3,
      members: null,
      flows: null,
      webhooks: null,
    })
  })

  it('mescla sem apagar as outras chaves; null remove a chave (volta a ilimitado)', () => {
    const settings = {
      description: 'x',
      connection_status_emails_enabled: true,
      limits: { connections: 5, ai_agents: 2 },
    }
    const next = mergeCompanyLimits(settings, { limits: { connections: 1, members: 10, ai_agents: null } })
    expect(next).toEqual({
      description: 'x',
      connection_status_emails_enabled: true,
      limits: { connections: 1, members: 10 },
    })
    expect(settings.limits).toEqual({ connections: 5, ai_agents: 2 })
    const cleared = mergeCompanyLimits(next, { limits: { connections: null, members: null } })
    expect(cleared).toEqual({ description: 'x', connection_status_emails_enabled: true })
    expect(readCompanyLimits(cleared).connections).toBeNull()
  })

  it('inbox_limits: grava os três, null remove; incompleto não é lido', () => {
    const next = mergeCompanyLimits({ a: 1 }, { inboxLimits: { waiting: 10, attending: 5, resolved: 0 } })
    expect(readInboxLimits(next)).toEqual({ waiting: 10, attending: 5, resolved: 0 })
    expect(mergeCompanyLimits(next, { inboxLimits: null })).toEqual({ a: 1 })
    expect(readInboxLimits({ inbox_limits: { waiting: 1 } })).toBeNull()
  })
})

describe('papéis da referência → nossos', () => {
  it('admin → platform_admin; support → support; client/client_employee → user', () => {
    expect(systemRoleFromLegacy('admin')).toBe('platform_admin')
    expect(systemRoleFromLegacy('support')).toBe('support')
    expect(systemRoleFromLegacy('client')).toBe('user')
    expect(systemRoleFromLegacy('client_employee')).toBe('user')
  })

  it('system_role explícito vence o role legado; nenhum → undefined', () => {
    expect(resolveSystemRole({ system_role: 'support', role: 'admin' })).toBe('support')
    expect(resolveSystemRole({ role: 'admin' })).toBe('platform_admin')
    expect(resolveSystemRole({})).toBeUndefined()
  })

  it('no fio: user dono de empresa = client; senão client_employee', () => {
    expect(legacyRoleOf('user', true)).toBe('client')
    expect(legacyRoleOf('user', false)).toBe('client_employee')
    expect(legacyRoleOf('platform_admin', false)).toBe('admin')
    expect(legacyRoleOf('support', true)).toBe('support')
  })
})

describe('período das estatísticas', () => {
  const now = new Date('2026-11-01T02:00:00Z') // ainda 31/10 em São Paulo
  it('padrão = últimos 7 dias no fuso, inclusivos', () => {
    expect(statsDayIn(now, 'America/Sao_Paulo')).toBe('2026-10-31')
    expect(resolveStatsPeriod({}, now, 'America/Sao_Paulo')).toEqual({ startDate: '2026-10-25', endDate: '2026-10-31' })
    expect(resolveStatsPeriod({ start_date: '2026-02-26' }, now, 'UTC')).toEqual({
      startDate: '2026-02-26',
      endDate: '2026-03-04',
    })
  })

  it('dias inclusivos e virada de mês/ano', () => {
    expect(statsDays('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(addStatsDays('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('data inválida, invertida ou janela acima de 366 dias → erro de validação', () => {
    for (const input of [
      { start_date: '2026-02-30' },
      { end_date: '16/10/2026' },
      { start_date: '2026-10-10', end_date: '2026-10-01' },
      { start_date: '2024-01-01', end_date: '2026-01-01' },
    ]) {
      try {
        resolveStatsPeriod(input, now, 'UTC')
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(AdminError)
        expect((err as AdminError).code).toBe('validation')
      }
    }
  })
})
