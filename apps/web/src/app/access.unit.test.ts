import { describe, expect, it } from 'vitest'
import { effectivePermissions, type CompanyRole } from '@crm/shared'
import { canAccess, homeOf, visibleBottomNav, visibleSections } from './access'
import { decide, DeniedNotice, splitHref } from './guard'
import type { Session } from '@/lib/session'

function session(role: CompanyRole | null, systemRole: 'user' | 'support' | 'platform_admin' = 'user'): Session {
  return {
    user: { id: 'u', email: 'u@x.com', name: 'U', system_role: systemRole, locale: 'pt-BR', avatar_url: null, last_company_id: 'c', created_at: '2026-01-01T00:00:00Z' },
    companies: role ? [{ id: 'c', name: 'C', slug: 'c', role }] : [],
    company: role ? { id: 'c', name: 'C', slug: 'c', role } : null,
    role,
    isOwner: role === 'owner',
    isSupport: systemRole === 'support',
    isPlatformAdmin: systemRole === 'platform_admin',
    perms: role ? effectivePermissions({ role, permission_keys: null, system_role: systemRole }) : new Set(),
  }
}

const ids = (s: Session) => visibleSections(s).flatMap((sec) => sec.items.map((i) => i.id))

describe('navegação por papel (AC-T23-02)', () => {
  it('owner, admin e member do seed', () => {
    expect(ids(session('owner'))).toEqual(['dashboard', 'chats', 'kanban', 'contacts', 'flows', 'agents', 'connections', 'inbound-webhooks', 'mass-dispatch', 'facebook', 'settings', 'tutorials'])
    expect(ids(session('admin'))).toEqual(ids(session('owner')))
    expect(ids(session('member'))).toEqual(['chats', 'kanban', 'contacts', 'flows', 'agents', 'mass-dispatch', 'settings', 'tutorials'])
    expect(ids(session('admin', 'platform_admin'))).toContain('admin')
    expect(ids(session('member', 'support'))).toEqual(['support-access'])
  })

  it('barra inferior e home', () => {
    expect(visibleBottomNav(session('member')).map((i) => i.id)).toEqual(['chats', 'kanban', 'flows'])
    expect(visibleBottomNav(session('owner')).map((i) => i.id)).toEqual(['home', 'chats', 'kanban', 'flows'])
    expect(homeOf(session('owner'))).toBe('/welcome')
    expect(homeOf(session('member'))).toBe('/chats')
    expect(homeOf(session('member', 'support'))).toBe('/support/access')
    expect(homeOf(session(null))).toBe('/profile')
  })

  it('guarda por prefixo', () => {
    const m = session('member')
    expect(canAccess(m, '/connections')).toBe(false)
    expect(canAccess(m, '/welcome')).toBe(false)
    expect(canAccess(m, '/chats/123')).toBe(true)
    expect(canAccess(m, '/settings/inbound-webhooks')).toBe(false)
    expect(canAccess(m, '/settings')).toBe(true)
    expect(canAccess(m, '/profile')).toBe(true)
    expect(canAccess(m, '/rota-desconhecida')).toBe(true)
    expect(canAccess(m, '/admin')).toBe(false)
    expect(canAccess(session('member', 'support'), '/chats')).toBe(false)
    expect(canAccess(session('member', 'support'), '/flows/x')).toBe(true)
  })
})

describe('decide (AC-T23-01/02/05)', () => {
  it('sem sessão → login com redirect; / → home; negado → home com aviso; legado → destino', () => {
    expect(decide(null, '/chats', '/chats?x=1')).toEqual({ kind: 'redirect', href: '/login?redirect=%2Fchats%3Fx%3D1', denied: false })
    expect(decide(null, '/login', '/login')).toEqual({ kind: 'allow' })
    expect(decide(session('member'), '/', '/')).toEqual({ kind: 'redirect', href: '/chats', denied: false })
    expect(decide(session('member'), '/welcome', '/welcome')).toEqual({ kind: 'redirect', href: '/chats', denied: true })
    expect(decide(session('member'), '/connections', '/connections')).toEqual({ kind: 'redirect', href: '/chats', denied: true })
    expect(decide(session('owner'), '/users', '/users')).toEqual({ kind: 'redirect', href: '/settings?tab=team', denied: false })
    expect(decide(session('owner'), '/nao-existe', '/nao-existe')).toEqual({ kind: 'allow' })
  })

  it('aviso uma vez por caminho seguido', () => {
    const n = new DeniedNotice(1000)
    expect(n.shouldNotify('/a', 0)).toBe(true)
    expect(n.shouldNotify('/a', 500)).toBe(false)
    expect(n.shouldNotify('/b', 600)).toBe(true)
    expect(n.shouldNotify('/b', 2000)).toBe(true)
    expect(splitHref('/settings?tab=team')).toEqual({ to: '/settings', search: { tab: 'team' } })
  })
})
