// Escopo da concessão de suporte (T32): só `flows.*` e `settings.mcp.*` (+ `settings.view` da normalização).
import { ALWAYS_GRANTED_PERMISSIONS, PERMISSION_KEYS } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { resolutionPermissions } from '../platform/company-context'
import { SUPPORT_GRANT_PERMISSIONS, SUPPORT_GRANT_TTL_MS, supportGrantPermissions } from './grants'

describe('escopo da concessão de suporte', () => {
  it('cobre todo flows.* e settings.mcp.* do catálogo, mais settings.view', () => {
    const expected = PERMISSION_KEYS.filter((k) => k.startsWith('flows.') || k.startsWith('settings.mcp.'))
    expect(expected.length).toBeGreaterThanOrEqual(7)
    expect(new Set(SUPPORT_GRANT_PERMISSIONS)).toEqual(new Set([...expected, 'settings.view']))
  })

  it('não inclui contatos, chat, equipe nem as chaves sempre concedidas (profile/global_variables)', () => {
    const perms = supportGrantPermissions()
    for (const k of ['contacts.view', 'chat.view', 'team.view', 'settings.global_variables.view', ...ALWAYS_GRANTED_PERMISSIONS]) {
      expect(perms.has(k as never), k).toBe(false)
    }
  })

  it('concessão dura 12 h', () => {
    expect(SUPPORT_GRANT_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })

  it('resolutionPermissions: vínculo vence a concessão; sem vínculo nem concessão → vazio', () => {
    const grant = { id: 'g', companyId: 'c', supportUserId: 'u', expiresAt: new Date() }
    expect(resolutionPermissions({ member: null, supportGrant: grant }, { systemRole: 'support' })).toEqual(supportGrantPermissions())
    expect(resolutionPermissions({ member: null }, { systemRole: 'support' }).size).toBe(0)
    const owner = { id: 'm', companyId: 'c', userId: 'u', role: 'owner' as const, permissionKeys: null }
    expect(resolutionPermissions({ member: owner, supportGrant: grant }, { systemRole: 'user' }).has('contacts.view')).toBe(true)
  })
})
