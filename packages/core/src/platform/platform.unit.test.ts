import { describe, expect, it } from 'vitest'
import { stripSecrets } from './audit-service'
import { apiTokenPermissions, isUuid, permissionsOf } from './company-context'
import { generateApiToken, generateSessionToken, hashToken, isApiToken } from './tokens'

describe('tokens', () => {
  it('hash sha256 hex e formatos', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(generateSessionToken()).not.toBe(generateSessionToken())
    expect(isApiToken(generateApiToken())).toBe(true)
    expect(isApiToken('crm_pat_')).toBe(false)
    expect(isApiToken(generateSessionToken())).toBe(false)
  })
})

describe('stripSecrets', () => {
  it('remove chaves sensíveis em qualquer profundidade', () => {
    const out = stripSecrets({ name: 'a', password: 'p', deep: { list: [{ apiKey: 'k', ok: 1 }], Authorization: 'x' }, when: new Date(0) })
    expect(out).toEqual({ name: 'a', deep: { list: [{ ok: 1 }] }, when: '1970-01-01T00:00:00.000Z' })
  })
})

describe('permissões', () => {
  const member = { id: 'm', companyId: 'c', userId: 'u', permissionKeys: ['chat.view'] }
  it('lista explícita substitui a matriz; owner tem tudo; sem membro nada', () => {
    expect(permissionsOf({ ...member, role: 'member' }, null).has('contacts.edit')).toBe(false)
    expect(permissionsOf({ ...member, role: 'member' }, null).has('chat.view')).toBe(true)
    expect(permissionsOf({ ...member, role: 'owner' }, null).has('contacts.edit')).toBe(true)
    expect(permissionsOf(null, null).size).toBe(0)
    expect(apiTokenPermissions().has('contacts.edit')).toBe(true)
  })

  it('isUuid', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true)
    expect(isUuid('x')).toBe(false)
  })
})
