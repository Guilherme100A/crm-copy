import { describe, expect, it } from 'vitest'
import { PERMISSION_CATALOG, PERMISSION_KEYS, isPermissionKey } from './catalog'
import { DEFAULT_ROLE_PERMISSIONS } from './defaults'
import { can, effectivePermissions, normalizePermissions, revokePermission } from './resolve'

describe('permissions/catalog', () => {
  it('não tem billing.* e não repete chaves', () => {
    expect(PERMISSION_KEYS.some((k) => k.startsWith('billing.'))).toBe(false)
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length)
    expect(PERMISSION_CATALOG.map((g) => g.group)).toContain('settings')
    expect(isPermissionKey('billing.view')).toBe(false)
    expect(isPermissionKey('profile.view')).toBe(true)
  })

  it('platform_invitations é só do owner na matriz padrão', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.admin).not.toContain('settings.platform_invitations.view')
    expect(DEFAULT_ROLE_PERMISSIONS.owner).toContain('settings.platform_invitations.delete')
  })
})

describe('can()', () => {
  it('owner sempre true', () => {
    expect(can({ role: 'owner', permission_keys: ['chat.view'] }, 'team.delete')).toBe(true)
    expect(can({ role: 'owner' }, 'anything.else')).toBe(true)
  })

  it('usa a matriz padrão sem lista explícita', () => {
    const member = { role: 'member' as const, permission_keys: null }
    expect(can(member, 'chat.view')).toBe(true)
    expect(can(member, 'settings.quick_replies.edit')).toBe(true)
    expect(can(member, 'contacts.edit')).toBe(false)
    expect(can({ role: 'admin', permission_keys: [] }, 'team.edit')).toBe(true)
  })

  it('lista explícita não vazia substitui a matriz do papel', () => {
    const admin = { role: 'admin' as const, permission_keys: ['contacts.view'] }
    expect(can(admin, 'contacts.view')).toBe(true)
    expect(can(admin, 'team.view')).toBe(false)
    expect(can({ role: 'member', permissionKeys: ['webhooks.edit'] }, 'webhooks.view')).toBe(true)
  })

  it('profile.view e settings.global_variables.* sempre concedidos', () => {
    for (const subject of [
      { role: 'member' as const, permission_keys: ['chat.view'] },
      { role: 'admin' as const, permission_keys: null },
      { role: 'member' as const, permission_keys: null, system_role: 'support' as const },
    ]) {
      expect(can(subject, 'profile.view')).toBe(true)
      expect(can(subject, 'settings.global_variables.view')).toBe(true)
      expect(can(subject, 'settings.global_variables.delete')).toBe(true)
    }
  })

  it('suporte sem lista explícita não herda a matriz', () => {
    const support = { role: 'member' as const, permission_keys: null, system_role: 'support' as const }
    expect(can(support, 'chat.view')).toBe(false)
    expect([...effectivePermissions(support)].sort()).toEqual(
      ['profile.view', 'settings.global_variables.delete', 'settings.global_variables.edit', 'settings.global_variables.view'],
    )
  })
})

describe('normalizePermissions()', () => {
  it('acrescenta dependências sem duplicar', () => {
    expect(normalizePermissions(['chat.block', 'contacts.edit'])).toEqual([
      'chat.view',
      'chat.block',
      'contacts.view',
      'contacts.edit',
      'settings.view',
    ])
    expect(normalizePermissions(['chat.view', 'chat.block', 'chat.block'])).toEqual(['chat.view', 'chat.block'])
  })

  it('settings.<área>.edit ⇒ view da área + settings.view; descarta chaves desconhecidas', () => {
    expect(normalizePermissions(['settings.labels.delete', 'billing.view', 'x'])).toEqual([
      'settings.view',
      'settings.labels.view',
      'settings.labels.delete',
    ])
  })

  it('revokePermission aplica a cascata inversa', () => {
    expect(revokePermission(['chat.view', 'chat.block', 'contacts.view', 'contacts.edit'], 'chat.view')).toEqual([
      'contacts.view',
      'contacts.edit',
      'settings.view',
    ])
    expect(revokePermission(['contacts.view', 'contacts.delete'], 'contacts.view')).toEqual([])
  })
})
