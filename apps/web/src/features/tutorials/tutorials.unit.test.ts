import { describe, expect, it } from 'vitest'
import { visibleSections } from '@/app/access'
import { NAV_SECTIONS, TUTORIALS_URL } from '@/app/nav'
import { sessionFrom, type Profile } from '@/lib/session'
import { safeExternalUrl, TUTORIALS_LINK_REL, tutorialsUrlOf, withTutorials } from './tutorials'

const URL_T = 'https://videos.example.com/tutoriais'

function session(role: 'owner' | 'admin' | 'member' | null, extra: Partial<Profile['user']> = {}) {
  const profile = {
    user: { id: 'u1', email: 'a@b.test', name: 'A', last_company_id: 'c1', system_role: null, ...extra },
    companies: role ? [{ id: 'c1', name: 'C', slug: 'c', role, ...(role === 'member' ? { effective_permissions: ['chat.view'] } : {}) }] : [],
  } as unknown as Profile
  return sessionFrom(profile)
}

const ids = (sections: ReturnType<typeof withTutorials>) => sections.flatMap((s) => s.items.map((i) => i.id))
const tutorialsOf = (sections: ReturnType<typeof withTutorials>) => sections.flatMap((s) => s.items).find((i) => i.id === 'tutorials')
const nav = (s: ReturnType<typeof session>, url: string | null) => withTutorials(visibleSections(s), NAV_SECTIONS, url, s.isSupport)

describe('AC-T108-01 item Tutoriais', () => {
  it('sem fallback fixo: sem VITE_TUTORIALS_URL o valor de build é vazio', () => {
    expect(TUTORIALS_URL).toBe('')
    expect(tutorialsUrlOf(undefined)).toBeNull()
  })

  it('com URL aparece no fim de GESTÃO, com a URL de runtime, para owner/admin/member', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const sections = nav(session(role), URL_T)
      expect(ids(sections).at(-1)).toBe('tutorials')
      expect(sections.find((s) => s.id === 'management')?.items.at(-1)?.id).toBe('tutorials')
      expect(tutorialsOf(sections)?.href).toBe(URL_T)
    }
  })

  it('aparece mesmo sem nenhum outro item de GESTÃO (membro sem settings.view)', () => {
    const s = session('member')
    expect(visibleSections(s).some((sec) => sec.id === 'management')).toBe(false)
    const sections = nav(s, URL_T)
    expect(sections.at(-1)?.id).toBe('management')
    expect(ids(sections)).toEqual(['chats', 'tutorials'])
  })

  it('sem URL não aparece (e GESTÃO só com ele some)', () => {
    expect(ids(nav(session('owner'), null))).not.toContain('tutorials')
    expect(nav(session('member'), null).some((sec) => sec.id === 'management')).toBe(false)
  })

  it('usuário support nunca vê', () => {
    const s = session(null, { system_role: 'support' } as Partial<Profile['user']>)
    expect(s.isSupport).toBe(true)
    expect(ids(nav(s, URL_T))).not.toContain('tutorials')
  })

  it('URL só de config carregada e http/https; antes de carregar, só a de build', () => {
    expect(tutorialsUrlOf({ tutorials_url: URL_T })).toBe(URL_T)
    expect(tutorialsUrlOf({ tutorials_url: null }, 'https://build.example.com/')).toBeNull()
    expect(tutorialsUrlOf({ affiliate_portal_url: null }, 'https://build.example.com/')).toBeNull()
    expect(tutorialsUrlOf(undefined, 'https://build.example.com/')).toBe('https://build.example.com/')
    expect(tutorialsUrlOf({ tutorials_url: 'javascript:alert(1)' })).toBeNull()
    expect(safeExternalUrl(' http://x.example.com ')).toBe('http://x.example.com/')
    expect(safeExternalUrl('ftp://x')).toBeNull()
  })

  it('abre em nova aba com noopener', () => {
    expect(TUTORIALS_LINK_REL).toMatch(/\bnoopener\b/)
  })
})
