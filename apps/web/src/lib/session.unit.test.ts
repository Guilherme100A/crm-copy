import { describe, expect, it } from 'vitest'
import { hasAny, sessionFrom, type Profile } from './session'

const profile = (company: Profile['companies'][number]): Profile => ({
  user: { id: 'u1', email: 'a@x.com', name: 'A', system_role: 'user', locale: 'pt-BR', avatar_url: null, last_company_id: company.id, created_at: '2026-10-16T00:00:00Z' },
  companies: [company],
})

describe('sessionFrom: permissões efetivas (T91)', () => {
  it('usa effective_permissions do perfil (lista explícita do membro)', () => {
    const s = sessionFrom(profile({ id: 'c1', name: 'C', slug: 'c', role: 'member', effective_permissions: ['chat.view', 'flows.view', 'profile.view'] }))
    expect(hasAny(s, ['flows.view'])).toBe(true)
    expect(hasAny(s, ['flows.run'])).toBe(false)
  })

  it('sem o campo, cai na matriz do papel (o member padrão tem flows.run)', () => {
    const s = sessionFrom(profile({ id: 'c1', name: 'C', slug: 'c', role: 'member' }))
    expect(hasAny(s, ['flows.run'])).toBe(true)
  })
})
