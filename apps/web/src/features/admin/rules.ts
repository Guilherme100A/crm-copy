// Regras puras do admin interno (T100; 20-admin-interno.md §2–§5): abas e grupos, validações dos modais (usuário,
// aviso, banner, créditos), "atualizado às HH:MM" e os avisos fechados localmente pelo cliente (14 §14).
import { readStorage, writeStorage } from '@/lib/storage'

/** Abas do hub `/admin?tab=`, na ordem do menu (20 §2). Só as que têm backend (T95/T96/T37). */
export const ADMIN_TABS = [
  { id: 'overview', group: 'platform' },
  { id: 'users', group: 'platform' },
  { id: 'accounts', group: 'platform' },
  { id: 'announcements', group: 'platform' },
  { id: 'banners', group: 'platform' },
  { id: 'health', group: 'infrastructure' },
  { id: 'sessions', group: 'infrastructure' },
  { id: 'ai', group: 'product' },
] as const

export type AdminTabId = (typeof ADMIN_TABS)[number]['id']
export const ADMIN_GROUPS = ['platform', 'infrastructure', 'product'] as const
export const DEFAULT_ADMIN_TAB: AdminTabId = 'overview'

/** Abas visíveis: no modo extensão (`GET /api/admin/wa/sessions` → 404) a aba Sessões some. */
export function visibleAdminTabs(opts: { sessionsAvailable: boolean }): AdminTabId[] {
  return ADMIN_TABS.map((t) => t.id).filter((id) => id !== 'sessions' || opts.sessionsAvailable)
}

/** `?tab=` ausente, inválido ou escondido → "Visão geral". */
export function resolveAdminTab(tab: unknown, visible: readonly AdminTabId[]): AdminTabId {
  return typeof tab === 'string' && (visible as readonly string[]).includes(tab) ? (tab as AdminTabId) : DEFAULT_ADMIN_TAB
}

/** Lista das abas de lista (20 §2): 20 por página; a busca espera 450 ms sem digitar. */
export const ADMIN_PAGE_SIZE = 20
export const ADMIN_SEARCH_DEBOUNCE_MS = 450

// ---------------------------------------------------------------- usuários (20 §3.1)

/** Papéis legados da plataforma (20 §4), na ordem do select. */
export const USER_ROLES = ['client', 'client_employee', 'admin', 'support'] as const
export type UserRole = (typeof USER_ROLES)[number]
export const DEFAULT_USER_ROLE: UserRole = 'client_employee'

/** Mesma regex do servidor (`^\S+@\S+\.\S+$`). */
export const EMAIL_RE = /^\S+@\S+\.\S+$/
export const PASSWORD_MIN = 6

export interface UserDraft {
  name: string
  email: string
  personal_whatsapp: string
  role: UserRole
  password: string
  password_confirmation: string
}

export type UserDraftErrors = Partial<Record<'name' | 'email' | 'password' | 'password_confirmation', string>>

/** Chaves de i18n (`admin:users.errors.*`) por campo. Ao editar, senha vazia = não muda. */
export function validateUserDraft(d: UserDraft, mode: 'create' | 'edit'): UserDraftErrors {
  const e: UserDraftErrors = {}
  if (!d.name.trim()) e.name = 'nameRequired'
  if (mode === 'create' && !EMAIL_RE.test(d.email.trim())) e.email = 'emailInvalid'
  const wantsPassword = mode === 'create' || d.password.length > 0 || d.password_confirmation.length > 0
  if (wantsPassword) {
    if (d.password.length < PASSWORD_MIN) e.password = 'passwordShort'
    else if (d.password !== d.password_confirmation) e.password_confirmation = 'passwordMismatch'
  }
  return e
}

/** Corpo do POST/PUT: e-mail só na criação (imutável); senha só quando informada. */
export function userPayload(d: UserDraft, mode: 'create' | 'edit'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    personal_whatsapp: d.personal_whatsapp.trim() || null,
    role: d.role,
  }
  if (mode === 'create') body.email = d.email.trim()
  if (mode === 'create' || d.password) {
    body.password = d.password
    body.password_confirmation = d.password_confirmation
  }
  return body
}

// ---------------------------------------------------------------- avisos e banners (20 §3.6, §3.7)

export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'error', 'success'] as const
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number]

export const isHttpUrl = (v: string) => {
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** `datetime-local` (hora local do navegador) → ISO com offset; vazio → null. */
export function localInputToIso(v: string): string | null {
  if (!v.trim()) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** ISO → valor do `datetime-local` na hora local. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface AnnouncementDraft {
  title: string
  message: string
  announcement_type: AnnouncementType
  image_url: string
  url: string
  priority: string
  expires_at: string
  active: boolean
}

export interface BannerDraft {
  title: string
  image_url: string
  url: string
  priority: string
  expires_at: string
  active: boolean
}

type Errors<K extends string> = Partial<Record<K, string>>

const priorityError = (v: string) => (v.trim() === '' || /^-?\d+$/.test(v.trim()) ? null : 'priorityInvalid')

export function validateAnnouncementDraft(d: AnnouncementDraft): Errors<'title' | 'message' | 'image_url' | 'url' | 'priority'> {
  const e: Errors<'title' | 'message' | 'image_url' | 'url' | 'priority'> = {}
  if (!d.title.trim()) e.title = 'titleRequired'
  else if (d.title.trim().length > 200) e.title = 'titleLong'
  if (!d.message.trim()) e.message = 'messageRequired'
  else if (d.message.trim().length > 5000) e.message = 'messageLong'
  if (d.image_url.trim() && !isHttpUrl(d.image_url)) e.image_url = 'urlInvalid'
  if (d.url.trim() && !isHttpUrl(d.url)) e.url = 'urlInvalid'
  const p = priorityError(d.priority)
  if (p) e.priority = p
  return e
}

export function validateBannerDraft(d: BannerDraft): Errors<'image_url' | 'url' | 'priority'> {
  const e: Errors<'image_url' | 'url' | 'priority'> = {}
  if (!d.image_url.trim()) e.image_url = 'imageRequired'
  else if (!isHttpUrl(d.image_url)) e.image_url = 'urlInvalid'
  if (d.url.trim() && !isHttpUrl(d.url)) e.url = 'urlInvalid'
  const p = priorityError(d.priority)
  if (p) e.priority = p
  return e
}

/** 20 §3.7: o salvar do banner fica desabilitado enquanto não houver imagem. */
export const bannerCanSave = (d: BannerDraft, uploading: boolean) => !uploading && d.image_url.trim().length > 0

export function announcementPayload(d: AnnouncementDraft): Record<string, unknown> {
  return {
    title: d.title.trim(),
    message: d.message.trim(),
    announcement_type: d.announcement_type,
    image_url: d.image_url.trim(),
    url: d.url.trim(),
    priority: d.priority.trim() ? Number(d.priority.trim()) : 0,
    expires_at: localInputToIso(d.expires_at),
    active: d.active,
  }
}

export function bannerPayload(d: BannerDraft): Record<string, unknown> {
  return {
    title: d.title.trim() || null,
    image_url: d.image_url.trim(),
    url: d.url.trim(),
    priority: d.priority.trim() ? Number(d.priority.trim()) : 0,
    expires_at: localInputToIso(d.expires_at),
    active: d.active,
  }
}

/** Upload aceito no cliente (o servidor confere de novo pelos bytes). */
export const UPLOAD_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024

export function uploadIssue(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!(UPLOAD_MIMES as readonly string[]).includes(file.type)) return 'type'
  if (file.size > UPLOAD_MAX_BYTES) return 'size'
  return null
}

// ---------------------------------------------------------------- créditos de IA (T37)

export type CreditsMode = 'topup' | 'adjust'

export interface CreditsDraft {
  credits: string
  note: string
}

/** Recarga > 0; ajuste ≠ 0 (pode ser negativo); nota obrigatória (1–500). */
export function validateCreditsDraft(d: CreditsDraft, mode: CreditsMode): Errors<'credits' | 'note'> {
  const e: Errors<'credits' | 'note'> = {}
  const raw = d.credits.trim()
  const n = Number(raw)
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n)) e.credits = 'creditsInvalid'
  else if (mode === 'topup' && n <= 0) e.credits = 'creditsPositive'
  else if (mode === 'adjust' && n === 0) e.credits = 'creditsNonZero'
  if (!d.note.trim()) e.note = 'noteRequired'
  else if (d.note.trim().length > 500) e.note = 'noteLong'
  return e
}

// ---------------------------------------------------------------- "atualizado às HH:MM"

/** Hora local `HH:MM` de um ISO/epoch; inválido → null. */
export function formatHHMM(at: string | number | Date | null | undefined): string | null {
  if (at === null || at === undefined || at === '' || at === 0) return null
  const d = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(d.getTime())) return null
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------- pop-up de aviso no app do cliente (14 §12–§14)

export const dismissedKey = (userId: string) => `dismissedAnnouncements:${userId}`

/** Ids fechados por este usuário neste navegador (storage ilegível → nenhum). */
export function readDismissed(userId: string): string[] {
  try {
    const raw = readStorage(dismissedKey(userId))
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** "Fechar" só oculta localmente (não chama API). Guarda no máximo os 200 mais recentes. */
export function dismissAnnouncement(userId: string, id: string): string[] {
  const next = [...readDismissed(userId).filter((x) => x !== id), id].slice(-200)
  try {
    writeStorage(dismissedKey(userId), JSON.stringify(next))
  } catch {
    // sem storage: o aviso fica oculto só nesta página
  }
  return next
}

/** O próximo aviso a mostrar: a lista já vem por prioridade do servidor; pula os fechados. */
export function nextAnnouncement<T extends { id: string }>(items: readonly T[], dismissed: readonly string[]): T | null {
  return items.find((a) => !dismissed.includes(a.id)) ?? null
}
