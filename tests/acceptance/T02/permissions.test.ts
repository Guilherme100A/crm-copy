import { describe, expect, it } from 'vitest'
import { catalogKeys, EXPECTED_CATALOG, fn, member } from './contract'

const ALWAYS = ['profile.view', 'settings.global_variables.view']

describe('T02 — catálogo e can() (SPEC 3.3, 16#8)', () => {
  it('AC-T02-02 nenhuma chave billing.* existe no catálogo', () => {
    const keys = catalogKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => k.startsWith('billing'))).toEqual([])
  })

  it('AC-T02-02 o catálogo tem as chaves de 16#8.1 (exceto billing.*)', () => {
    const keys = new Set(catalogKeys())
    expect(EXPECTED_CATALOG.filter((k) => !keys.has(k))).toEqual([])
  })

  it('AC-T02-02 owner sempre true, com ou sem lista explícita', () => {
    const can = fn('can')
    const keys = [...catalogKeys(), ...ALWAYS]
    for (const m of [member('owner'), member('owner', []), member('owner', ['chat.view'])]) {
      for (const k of keys) expect(can(m, k), `owner ${JSON.stringify(m.permission_keys)} → ${k}`).toBe(true)
    }
  })

  it('AC-T02-02 sem lista explícita vale a matriz padrão do papel (16#8.2)', () => {
    const can = fn('can')
    for (const keys of [null, []]) {
      const mem = member('member', keys)
      for (const k of ['chat.view', 'kanban.view', 'flows.view', 'contacts.view', 'settings.view', 'settings.labels.view', 'settings.quick_replies.edit', 'settings.global_variables.edit'])
        expect(can(mem, k), `member → ${k}`).toBe(true)
      for (const k of ['chat.block', 'contacts.edit', 'flows.delete', 'webhooks.view', 'connections.view', 'team.view', 'dashboard.sales', 'settings.labels.edit', 'facebook.pixel'])
        expect(can(mem, k), `member → ${k}`).toBe(false)

      const adm = member('admin', keys)
      for (const k of ['chat.block', 'contacts.delete', 'webhooks.edit', 'connections.delete', 'team.edit', 'dashboard.support', 'settings.labels.delete', 'facebook.campaigns'])
        expect(can(adm, k), `admin → ${k}`).toBe(true)
      expect(can(adm, 'settings.platform_invitations.view'), 'admin → settings.platform_invitations.view').toBe(false)
    }
  })

  it('AC-T02-02 lista explícita não vazia substitui a matriz do papel', () => {
    const can = fn('can')
    // member com uma chave fora da sua matriz: ganha a chave e perde o resto da matriz.
    const mem = member('member', ['webhooks.view'])
    expect(can(mem, 'webhooks.view')).toBe(true)
    expect(can(mem, 'chat.view')).toBe(false)
    expect(can(mem, 'kanban.view')).toBe(false)
    expect(can(mem, 'webhooks.edit')).toBe(false)

    // admin restrito por lista explícita.
    const adm = member('admin', ['chat.view'])
    expect(can(adm, 'chat.view')).toBe(true)
    expect(can(adm, 'team.view')).toBe(false)
    expect(can(adm, 'connections.edit')).toBe(false)

    // lista pode conceder o que a matriz não concede.
    expect(can(member('admin', ['settings.platform_invitations.view']), 'settings.platform_invitations.view')).toBe(true)
  })

  it('AC-T02-02 profile.view e settings.global_variables.view sempre concedidos', () => {
    const can = fn('can')
    for (const m of [member('member'), member('member', []), member('member', ['webhooks.view']), member('admin', ['chat.view']), member('owner')]) {
      for (const k of ALWAYS) expect(can(m, k), `${m.role} ${JSON.stringify(m.permission_keys)} → ${k}`).toBe(true)
    }
  })
})

describe('T02 — normalizePermissions (dependências)', () => {
  const asArray = (v: any): string[] => [...v]

  it('AC-T02-03 normalizePermissions([chat.block, contacts.edit]) acrescenta chat.view e contacts.view sem duplicar', () => {
    const out = asArray(fn('normalizePermissions')(['chat.block', 'contacts.edit']))
    expect(out).toEqual(expect.arrayContaining(['chat.block', 'chat.view', 'contacts.edit', 'contacts.view']))
    expect(out.length).toBe(new Set(out).size)
  })

  it('AC-T02-03 edit/delete ⇒ view; não duplica quando view já está na lista', () => {
    const normalize = fn('normalizePermissions')
    expect(asArray(normalize(['flows.delete']))).toContain('flows.view')
    expect(asArray(normalize(['connections.edit']))).toContain('connections.view')

    const out = asArray(normalize(['contacts.view', 'contacts.edit', 'contacts.delete', 'chat.view', 'chat.block']))
    expect(out.length).toBe(new Set(out).size)
    expect(out.filter((k) => k === 'contacts.view')).toHaveLength(1)
    expect(out.filter((k) => k === 'chat.view')).toHaveLength(1)
  })

  it('AC-T02-03 chave settings.<área>.* acrescenta settings.<área>.view e settings.view, sem duplicar', () => {
    const normalize = fn('normalizePermissions')
    const out = asArray(normalize(['settings.labels.edit']))
    expect(out).toEqual(expect.arrayContaining(['settings.labels.edit', 'settings.labels.view', 'settings.view']))

    const out2 = asArray(normalize(['settings.view', 'settings.labels.view', 'settings.labels.delete', 'settings.products.edit']))
    expect(out2).toEqual(expect.arrayContaining(['settings.products.view', 'settings.labels.view', 'settings.view']))
    expect(out2.length).toBe(new Set(out2).size)
    expect(out2.filter((k) => k === 'settings.view')).toHaveLength(1)
  })

  it('AC-T02-03 entrada duplicada sai sem duplicatas', () => {
    const out = asArray(fn('normalizePermissions')(['chat.block', 'chat.block', 'contacts.edit', 'contacts.edit']))
    expect(out.length).toBe(new Set(out).size)
    expect(out).toEqual(expect.arrayContaining(['chat.block', 'chat.view', 'contacts.edit', 'contacts.view']))
  })
})
