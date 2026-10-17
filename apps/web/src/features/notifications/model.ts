// Regras puras da central de notificações (T84; spec 14 §Features): preferências com os padrões de 14#10, badge
// "9+", expiração de 1 h, supressão do chat aberto e a decisão de tocar o som. Sem DOM: os efeitos ficam em `effects.ts`.

/** Chave das preferências no navegador (14#10). */
export const SETTINGS_KEY = 'notification_settings'
/** Itens da central (não há persistência no servidor; 14 §Lacunas). */
export const ITEMS_KEY = 'notification_center'

export const ITEM_TTL_MS = 60 * 60_000
export const CLEANUP_INTERVAL_MS = 10 * 60_000
export const TOAST_TIMEOUT_MS = 3_000
export const BROWSER_NOTIFICATION_TIMEOUT_MS = 5_000
/** Teto da lista (evita localStorage sem limite numa rajada de mensagens). */
export const MAX_ITEMS = 100

export interface NotificationSettings {
  enabled: boolean
  volume: number
  browserNotifications: boolean
  toastNotifications: boolean
  sounds: boolean
}

export const DEFAULT_SETTINGS: Readonly<NotificationSettings> = Object.freeze({
  enabled: true,
  volume: 50,
  browserNotifications: true,
  toastNotifications: true,
  sounds: true,
})

export type NotificationKind = 'message' | 'generic'

export interface NotificationItem {
  id: string
  kind: NotificationKind
  company_id: string
  /** Só `message`: chat de destino (`/chats/<id>`). */
  chat_id: string | null
  /** Só `generic`: destino opcional do evento. */
  url: string | null
  /** `null` = sem nome do contato no cache (a UI mostra o texto padrão). */
  title: string | null
  body: string
  /** Tipo da mensagem (`text`, `image`…) para o texto de mídia sem legenda. */
  message_type: string | null
  /** Epoch ms do recebimento. */
  at: number
  read: boolean
}

const clampVolume = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback
}

/** Lê as preferências salvas: campo ausente ou inválido cai no padrão de 14#10; volume fica em 0–100. */
export function parseSettings(raw: string | null | undefined): NotificationSettings {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    // JSON corrompido: padrões
  }
  const bool = (k: keyof NotificationSettings) =>
    typeof data[k] === 'boolean' ? (data[k] as boolean) : (DEFAULT_SETTINGS[k] as boolean)
  return {
    enabled: bool('enabled'),
    volume: clampVolume(data.volume, DEFAULT_SETTINGS.volume),
    browserNotifications: bool('browserNotifications'),
    toastNotifications: bool('toastNotifications'),
    sounds: bool('sounds'),
  }
}

export function mergeSettings(prev: NotificationSettings, patch: Partial<NotificationSettings>): NotificationSettings {
  const next = { ...prev, ...patch }
  return { ...next, volume: clampVolume(next.volume, prev.volume) }
}

/** Texto do badge (14#1): nada com 0, "9+" acima de 9. */
export function badgeLabel(count: number): string {
  if (count <= 0) return ''
  return count > 9 ? '9+' : String(count)
}

/** Remove itens com mais de 1 h (14#5). */
export function pruneExpired(items: readonly NotificationItem[], now: number): NotificationItem[] {
  return items.filter((i) => now - i.at <= ITEM_TTL_MS)
}

export const unreadCount = (items: readonly NotificationItem[], companyId: string | null | undefined, now: number) =>
  items.filter((i) => i.company_id === companyId && !i.read && now - i.at <= ITEM_TTL_MS).length

/** Chat aberto na URL atual (`/chats/<id>`), ou null. */
export function openChatIdFromPath(pathname: string): string | null {
  const m = /^\/chats\/([^/?#]+)/.exec(pathname)
  return m ? decodeURIComponent(m[1]!) : null
}

/** Toca o som? (14#8–#9): ativo, sons ligados, volume > 0 e fora da gravação de áudio. */
export const shouldPlaySound = (s: NotificationSettings, muted: boolean) =>
  s.enabled && s.sounds && s.volume > 0 && !muted

/** Ganho do oscilador para o volume 0–100 (curva leve; 100 ≈ 0,3 para não estourar). */
export const gainForVolume = (volume: number) => (Math.min(100, Math.max(0, volume)) / 100) * 0.3

interface MessageEventData {
  chat_id?: unknown
  message?: { id?: unknown; direction?: unknown; historical?: unknown; body?: unknown; type?: unknown } | null
}

/**
 * Item para `message.created` (AC-T84-01/02), ou null quando não notifica: saída, histórico (importação/sync),
 * mensagem do chat aberto agora ou central desligada.
 */
export function messageItem(
  data: unknown,
  ctx: {
    companyId: string
    now: number
    openChatId: string | null
    settings: NotificationSettings
    title: string | null
  },
): NotificationItem | null {
  if (!ctx.settings.enabled) return null
  const d = (data ?? {}) as MessageEventData
  const msg = d.message
  if (typeof d.chat_id !== 'string' || !msg || typeof msg.id !== 'string') return null
  if (msg.direction !== 'inbound' || msg.historical === true) return null
  if (ctx.openChatId === d.chat_id) return null
  return {
    id: msg.id,
    kind: 'message',
    company_id: ctx.companyId,
    chat_id: d.chat_id,
    url: null,
    title: ctx.title,
    body: typeof msg.body === 'string' ? msg.body : '',
    message_type: typeof msg.type === 'string' ? msg.type : null,
    at: ctx.now,
    read: false,
  }
}

/** Item para `notification.created { title, body, url? }` (AC-T84-05), ou null com a central desligada. */
export function genericItem(
  data: unknown,
  ctx: { id: string; companyId: string; now: number; settings: NotificationSettings },
): NotificationItem | null {
  if (!ctx.settings.enabled) return null
  const d = (data ?? {}) as { title?: unknown; body?: unknown; url?: unknown }
  const title = typeof d.title === 'string' ? d.title.trim() : ''
  const body = typeof d.body === 'string' ? d.body : ''
  if (!title && !body) return null
  return {
    id: ctx.id,
    kind: 'generic',
    company_id: ctx.companyId,
    chat_id: null,
    url: typeof d.url === 'string' && d.url.trim() ? d.url.trim() : null,
    title: title || null,
    body,
    message_type: null,
    at: ctx.now,
    read: false,
  }
}

/** Destino do clique: chat → `/chats/<id>`; genérico com caminho interno → ele; URL http(s) → externa; senão nada. */
export function itemTarget(item: NotificationItem): { internal: string } | { external: string } | null {
  if (item.kind === 'message' && item.chat_id) return { internal: `/chats/${encodeURIComponent(item.chat_id)}` }
  const url = item.url
  if (!url) return null
  if (url.startsWith('/') && !url.startsWith('//')) return { internal: url }
  if (/^https?:\/\//i.test(url)) return { external: url }
  return null
}

/** Insere no topo (dedupe por id: o SSE pode reentregar após reconectar) e aplica TTL e teto. */
export function addItem(
  items: readonly NotificationItem[],
  item: NotificationItem,
  now: number,
): NotificationItem[] | null {
  if (items.some((i) => i.id === item.id)) return null
  return pruneExpired([item, ...items], now).slice(0, MAX_ITEMS)
}

export function parseItems(raw: string | null | undefined): NotificationItem[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (i): i is NotificationItem =>
        !!i &&
        typeof i === 'object' &&
        typeof i.id === 'string' &&
        typeof i.at === 'number' &&
        (i.kind === 'message' || i.kind === 'generic'),
    )
  } catch {
    return []
  }
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'contact'])

/** Título e corpo exibidos (central, toast, navegador); `tr` traduz no namespace `notifications`. */
export function itemTexts(item: NotificationItem, tr: (key: string) => string): { title: string; body: string } {
  const title = item.title ?? tr(item.kind === 'message' ? 'item.newMessage' : 'item.generic')
  if (item.body.trim()) return { title, body: item.body }
  const type = item.message_type
  const body =
    item.kind === 'message'
      ? tr(type && MEDIA_TYPES.has(type) ? `media.${type === 'ptt' ? 'audio' : type}` : 'media.other')
      : ''
  return { title, body }
}
