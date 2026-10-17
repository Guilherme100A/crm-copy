import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canAccess, visibleSections } from '@/app/access'
import { HttpError } from '@/lib/http'
import { isExtensionMode } from './admin-page'
import {
  ADMIN_PAGE_SIZE,
  ADMIN_SEARCH_DEBOUNCE_MS,
  announcementPayload,
  bannerCanSave,
  bannerPayload,
  dismissAnnouncement,
  dismissedKey,
  formatHHMM,
  isoToLocalInput,
  localInputToIso,
  nextAnnouncement,
  readDismissed,
  resolveAdminTab,
  uploadIssue,
  userPayload,
  validateAnnouncementDraft,
  validateBannerDraft,
  validateCreditsDraft,
  validateUserDraft,
  visibleAdminTabs,
  type AnnouncementDraft,
  type BannerDraft,
  type UserDraft,
} from './rules'

describe('AC-T100-01 hub /admin?tab=', () => {
  const all = visibleAdminTabs({ sessionsAvailable: true })

  it('abas na ordem do menu, só as que têm backend (sem marca na id da IA)', () => {
    expect(all).toEqual(['overview', 'users', 'accounts', 'announcements', 'banners', 'health', 'sessions', 'ai'])
  })

  it('aba inválida ou ausente volta para "Visão geral"', () => {
    expect(resolveAdminTab(undefined, all)).toBe('overview')
    expect(resolveAdminTab('nada', all)).toBe('overview')
    expect(resolveAdminTab('servers', all)).toBe('overview')
    expect(resolveAdminTab(42, all)).toBe('overview')
    expect(resolveAdminTab('banners', all)).toBe('banners')
  })

  it('o item "Admin" do menu e a rota /admin só para platform_admin', () => {
    const base = { isOwner: true, isSupport: false, perms: new Set<string>() }
    const hasAdmin = (isPlatformAdmin: boolean) =>
      visibleSections({ ...base, isPlatformAdmin } as never).some((s) => s.items.some((i) => i.id === 'admin'))
    expect(hasAdmin(true)).toBe(true)
    expect(hasAdmin(false)).toBe(false)
    expect(canAccess({ ...base, isPlatformAdmin: false } as never, '/admin')).toBe(false)
    expect(canAccess({ ...base, isPlatformAdmin: true } as never, '/admin')).toBe(true)
  })
})

describe('AC-T100-04 modo extensão esconde a aba Sessões', () => {
  it('404 da sonda = modo extensão; outros erros mantêm a aba', () => {
    expect(isExtensionMode(new HttpError(404, 'NOT_FOUND', 'x'))).toBe(true)
    expect(isExtensionMode(new HttpError(502, 'UPSTREAM_ERROR', 'x'))).toBe(false)
    expect(isExtensionMode(null)).toBe(false)
  })

  it('sem sessões, `?tab=sessions` volta para a visão geral', () => {
    const v = visibleAdminTabs({ sessionsAvailable: false })
    expect(v).not.toContain('sessions')
    expect(resolveAdminTab('sessions', v)).toBe('overview')
  })
})

describe('AC-T100-02 listas e modal de usuário', () => {
  it('20 por página e debounce de 450 ms', () => {
    expect(ADMIN_PAGE_SIZE).toBe(20)
    expect(ADMIN_SEARCH_DEBOUNCE_MS).toBe(450)
  })

  const draft = (p: Partial<UserDraft> = {}): UserDraft => ({
    name: 'Ana',
    email: 'ana@x.com',
    personal_whatsapp: '',
    role: 'client_employee',
    password: '123456',
    password_confirmation: '123456',
    ...p,
  })

  it('criar: e-mail pela regex do servidor, senha ≥ 6 e confirmação', () => {
    expect(validateUserDraft(draft(), 'create')).toEqual({})
    expect(validateUserDraft(draft({ email: 'ana@x' }), 'create').email).toBe('emailInvalid')
    expect(validateUserDraft(draft({ email: 'a na@x.com' }), 'create').email).toBe('emailInvalid')
    expect(validateUserDraft(draft({ password: '12345', password_confirmation: '12345' }), 'create').password).toBe('passwordShort')
    expect(validateUserDraft(draft({ password_confirmation: '654321' }), 'create').password_confirmation).toBe('passwordMismatch')
    expect(validateUserDraft(draft({ name: '  ' }), 'create').name).toBe('nameRequired')
    expect(validateUserDraft(draft({ password: '', password_confirmation: '' }), 'create').password).toBe('passwordShort')
  })

  it('editar: senha vazia = não muda; e-mail não é validado nem enviado (imutável)', () => {
    const d = draft({ email: 'qualquer', password: '', password_confirmation: '' })
    expect(validateUserDraft(d, 'edit')).toEqual({})
    expect(userPayload(d, 'edit')).toEqual({ name: 'Ana', personal_whatsapp: null, role: 'client_employee' })
    expect(validateUserDraft(draft({ password: '123' }), 'edit').password).toBe('passwordShort')
    expect(userPayload(draft(), 'create')).toMatchObject({ email: 'ana@x.com', password: '123456', password_confirmation: '123456' })
  })
})

describe('AC-T100-03 avisos, banners, upload e pop-up', () => {
  const ann = (p: Partial<AnnouncementDraft> = {}): AnnouncementDraft => ({
    title: 'Manutenção',
    message: 'Hoje às 22h',
    announcement_type: 'warning',
    image_url: '',
    url: '',
    priority: '0',
    expires_at: '',
    active: true,
    ...p,
  })
  const ban = (p: Partial<BannerDraft> = {}): BannerDraft => ({ title: '', image_url: 'https://cdn.test/a.png', url: '', priority: '1', expires_at: '', active: true, ...p })

  it('aviso: título/mensagem obrigatórios, URLs http(s), prioridade inteira', () => {
    expect(validateAnnouncementDraft(ann())).toEqual({})
    expect(validateAnnouncementDraft(ann({ title: '' })).title).toBe('titleRequired')
    expect(validateAnnouncementDraft(ann({ message: ' ' })).message).toBe('messageRequired')
    expect(validateAnnouncementDraft(ann({ url: 'ftp://x' })).url).toBe('urlInvalid')
    expect(validateAnnouncementDraft(ann({ image_url: 'javascript:alert(1)' })).image_url).toBe('urlInvalid')
    expect(validateAnnouncementDraft(ann({ priority: '1.5' })).priority).toBe('priorityInvalid')
  })

  it('aviso: corpo limpa campos opcionais com "" e expira em ISO', () => {
    const body = announcementPayload(ann({ priority: '5', expires_at: '2026-12-31T23:30' }))
    expect(body).toMatchObject({ image_url: '', url: '', priority: 5, announcement_type: 'warning', active: true })
    expect(body.expires_at).toBe(new Date('2026-12-31T23:30').toISOString())
    expect(announcementPayload(ann()).expires_at).toBeNull()
  })

  it('banner: salvar desabilitado sem imagem (e durante o upload); título opcional vira null', () => {
    expect(bannerCanSave(ban({ image_url: '' }), false)).toBe(false)
    expect(bannerCanSave(ban(), true)).toBe(false)
    expect(bannerCanSave(ban(), false)).toBe(true)
    expect(validateBannerDraft(ban({ image_url: '' })).image_url).toBe('imageRequired')
    expect(bannerPayload(ban()).title).toBeNull()
  })

  it('upload: só imagem raster até 2 MB', () => {
    expect(uploadIssue({ type: 'image/png', size: 1000 })).toBeNull()
    expect(uploadIssue({ type: 'image/svg+xml', size: 10 })).toBe('type')
    expect(uploadIssue({ type: 'image/webp', size: 2 * 1024 * 1024 + 1 })).toBe('size')
  })

  it('datetime-local ↔ ISO na hora local', () => {
    const iso = localInputToIso('2026-10-17T08:05')!
    expect(isoToLocalInput(iso)).toBe('2026-10-17T08:05')
    expect(localInputToIso('')).toBeNull()
    expect(isoToLocalInput(null)).toBe('')
  })

  describe('pop-up: "fechar" só oculta localmente, por usuário', () => {
    const store = new Map<string, string>()
    beforeEach(() => {
      store.clear()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('fechar guarda o id do usuário e mostra o próximo', () => {
      const items = [{ id: 'a' }, { id: 'b' }]
      expect(nextAnnouncement(items, readDismissed('u1'))?.id).toBe('a')
      dismissAnnouncement('u1', 'a')
      expect(nextAnnouncement(items, readDismissed('u1'))?.id).toBe('b')
      dismissAnnouncement('u1', 'b')
      expect(nextAnnouncement(items, readDismissed('u1'))).toBeNull()
      // outro usuário no mesmo navegador ainda vê
      expect(nextAnnouncement(items, readDismissed('u2'))?.id).toBe('a')
      expect(JSON.parse(store.get(dismissedKey('u1'))!)).toEqual(['a', 'b'])
    })

    it('storage corrompido ou indisponível não quebra', () => {
      store.set(dismissedKey('u1'), '{nao json')
      expect(readDismissed('u1')).toEqual([])
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      })
      expect(readDismissed('u1')).toEqual([])
      expect(dismissAnnouncement('u1', 'x')).toEqual(['x'])
    })
  })
})

describe('AC-T100-04 atualizado às e créditos', () => {
  it('HH:MM na hora local', () => {
    const d = new Date(2026, 9, 17, 9, 7)
    expect(formatHHMM(d.toISOString())).toBe('09:07')
    expect(formatHHMM(d.getTime())).toBe('09:07')
    expect(formatHHMM(0)).toBeNull()
    expect(formatHHMM('x')).toBeNull()
  })

  it('recarga > 0, ajuste ≠ 0 (negativo ok) e nota obrigatória', () => {
    expect(validateCreditsDraft({ credits: '100', note: 'bônus' }, 'topup')).toEqual({})
    expect(validateCreditsDraft({ credits: '0', note: 'x' }, 'topup').credits).toBe('creditsPositive')
    expect(validateCreditsDraft({ credits: '-5', note: 'x' }, 'topup').credits).toBe('creditsPositive')
    expect(validateCreditsDraft({ credits: '-5', note: 'estorno' }, 'adjust')).toEqual({})
    expect(validateCreditsDraft({ credits: '0', note: 'x' }, 'adjust').credits).toBe('creditsNonZero')
    expect(validateCreditsDraft({ credits: '1.5', note: 'x' }, 'adjust').credits).toBe('creditsInvalid')
    expect(validateCreditsDraft({ credits: '10', note: '   ' }, 'topup').note).toBe('noteRequired')
    expect(validateCreditsDraft({ credits: '10', note: 'x'.repeat(501) }, 'topup').note).toBe('noteLong')
  })
})
