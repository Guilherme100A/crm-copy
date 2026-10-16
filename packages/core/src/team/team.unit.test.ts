import { describe, expect, it } from 'vitest'
import { normalizeTimeZone } from '../companies/service'
import { slugCandidate, slugify } from '../companies/slug'
import { dayInTimeZone } from '../invitations/service'
import { TeamError } from './errors'
import { normalizePermissionInput, permissionDefinitions } from './service'

describe('slug da empresa', () => {
  it('minúsculas, sem acento, hífens colapsados', () => {
    expect(slugify('  Ótica São João & Filhos  ')).toBe('otica-sao-joao-filhos')
    expect(slugify('A')).toBe('empresa-a')
    expect(slugify('!!!')).toBe('empresa')
    expect(slugify('x'.repeat(100))).toHaveLength(63)
  })

  it('candidatos numerados respeitam o tamanho máximo', () => {
    expect(slugCandidate('loja', 1)).toBe('loja')
    expect(slugCandidate('loja', 3)).toBe('loja-3')
    expect(slugCandidate('x'.repeat(63), 12)).toHaveLength(63)
  })
})

describe('fuso da empresa', () => {
  it('fora da lista cai no padrão; Buenos_Aires curto vira o IANA canônico', () => {
    expect(normalizeTimeZone('America/Manaus')).toBe('America/Manaus')
    expect(normalizeTimeZone('Europe/Paris')).toBe('America/Sao_Paulo')
    expect(normalizeTimeZone(undefined)).toBe('America/Sao_Paulo')
    expect(normalizeTimeZone('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires')
  })
})

describe('permissões do membro', () => {
  it('normaliza: edit sem view recebe view e settings.view; lista vazia volta à matriz', () => {
    expect(normalizePermissionInput(['contacts.edit'])).toEqual(expect.arrayContaining(['contacts.edit', 'contacts.view', 'settings.view']))
    expect(normalizePermissionInput(['chat.block'])).toEqual(['chat.view', 'chat.block'])
    expect(normalizePermissionInput([])).toBeNull()
    expect(normalizePermissionInput(null)).toBeNull()
  })

  it('chave fora do catálogo → erro de validação com o caminho de cada chave', () => {
    try {
      normalizePermissionInput(['contacts.view', 'billing.view', 'nada'])
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(TeamError)
      const e = err as TeamError
      expect(e.kind).toBe('validation')
      expect(e.details?.fields).toEqual([
        { path: 'permission_keys.1', message: 'Chave desconhecida: billing.view' },
        { path: 'permission_keys.2', message: 'Chave desconhecida: nada' },
      ])
    }
  })

  it('definições trazem grupos, seções fixas e a matriz do papel', () => {
    const d = permissionDefinitions('member')
    expect(d.groups.map((g) => g.key)).toContain('team')
    expect(d.always_granted).toContain('profile.view')
    expect(d.owner_only).toContain('settings.platform_invitations.view')
    expect(d.defaults).toContain('chat.view')
    expect(d.defaults).not.toContain('team.view')
    expect(permissionDefinitions()).not.toHaveProperty('defaults')
  })
})

describe('dia no fuso da empresa (limite diário de reenvio)', () => {
  it('a virada do dia segue o fuso', () => {
    const d = new Date('2026-10-16T02:30:00Z') // 23:30 do dia 15 em São Paulo
    expect(dayInTimeZone(d, 'America/Sao_Paulo')).toBe('2026-10-15')
    expect(dayInTimeZone(d, 'UTC')).toBe('2026-10-16')
  })
})
