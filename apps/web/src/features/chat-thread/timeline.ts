// Regras puras da conversa (T75): linha do tempo (mensagens + notas internas), ticks, citação, formatação WhatsApp
// e operações no cache paginado usadas pelo realtime (AC-T75-03/05).
import type { InfiniteData } from '@tanstack/react-query'
import type { MessageDto, MessagesPage, NoteDto, Reaction } from './api'

export type ThreadData = InfiniteData<MessagesPage, string | null>

export type TimelineItem = { kind: 'message'; at: string; message: MessageDto } | { kind: 'note'; at: string; note: NoteDto } | { kind: 'day'; at: string; day: string }

/** Mensagens em ordem cronológica (as páginas vêm da mais nova para a mais antiga). */
export function flattenMessages(data: ThreadData | undefined): MessageDto[] {
  if (!data) return []
  const out: MessageDto[] = []
  for (let i = data.pages.length - 1; i >= 0; i--) out.push(...data.pages[i]!.items)
  const seen = new Set<string>()
  return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

const dayOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Mescla mensagens e notas por data, com separadores de dia. Notas mais antigas que a mensagem mais antiga carregada
 * só entram quando não há mais páginas (senão apareceriam fora de lugar).
 */
export function buildTimeline(messages: MessageDto[], notes: NoteDto[], hasOlder: boolean): TimelineItem[] {
  const oldest = messages[0]?.created_at
  const visibleNotes = notes.filter((n) => !hasOlder || !oldest || n.created_at >= oldest)
  const items: TimelineItem[] = [
    ...messages.map((m): TimelineItem => ({ kind: 'message', at: m.created_at, message: m })),
    ...visibleNotes.map((n): TimelineItem => ({ kind: 'note', at: n.created_at, note: n })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const out: TimelineItem[] = []
  let last = ''
  for (const it of items) {
    const day = dayOf(it.at)
    if (day !== last) {
      out.push({ kind: 'day', at: it.at, day })
      last = day
    }
    out.push(it)
  }
  return out
}

export type TickKind = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' | 'none'

export function tickOf(m: Pick<MessageDto, 'direction' | 'status'>): TickKind {
  if (m.direction !== 'outbound') return 'none'
  switch (m.status) {
    case 'queued':
    case 'processing':
    case 'retrying':
      return 'pending'
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
    case 'cancelled':
      return m.status
    default:
      return 'none'
  }
}

export const isViewOnce = (m: Pick<MessageDto, 'media'>) => m.media?.view_once === true
export const hasMedia = (m: Pick<MessageDto, 'type' | 'media' | 'deleted_at'>) =>
  !m.deleted_at && ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type) && !!m.media
export const mediaFileName = (m: Pick<MessageDto, 'media'>) => (typeof m.media?.file_name === 'string' ? m.media.file_name : null)
export const isPtt = (m: Pick<MessageDto, 'media'>) => m.media?.ptt === true

/** Texto que "Copiar" leva (corpo, legenda ou o nome da localização/contato). */
export const copyText = (m: Pick<MessageDto, 'body'>) => m.body?.trim() || ''

/** Mensagem citada entre as carregadas (pelo id do WhatsApp). */
export function findQuoted(messages: MessageDto[], m: Pick<MessageDto, 'quoted_wa_message_id'>): MessageDto | null {
  if (!m.quoted_wa_message_id) return null
  return messages.find((x) => x.wa_message_id === m.quoted_wa_message_id) ?? null
}

/** Reações agrupadas por emoji (contagem). */
export function groupReactions(reactions: Reaction[] | undefined): { emoji: string; count: number }[] {
  const map = new Map<string, number>()
  for (const r of reactions ?? []) if (r.emoji) map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1)
  return [...map].map(([emoji, count]) => ({ emoji, count }))
}

// ---- formatação WhatsApp: *negrito*, _itálico_, ~riscado~, ```mono``` -----------------------------------------

export type FormatToken = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; mono?: boolean }

const MARKS: [string, keyof Omit<FormatToken, 'text'>][] = [
  ['```', 'mono'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strike'],
]

/** Quebra o texto em trechos com estilo (sem HTML: o React escapa tudo). Marcas sem par ficam como texto. */
export function formatWhatsApp(text: string, style: Omit<FormatToken, 'text'> = {}): FormatToken[] {
  const out: FormatToken[] = []
  let i = 0
  let buf = ''
  const flush = () => {
    if (buf) out.push({ text: buf, ...style })
    buf = ''
  }
  while (i < text.length) {
    let matched = false
    for (const [mark, key] of MARKS) {
      if (!text.startsWith(mark, i)) continue
      const end = text.indexOf(mark, i + mark.length)
      const inner = end > i + mark.length ? text.slice(i + mark.length, end) : ''
      // A marca precisa abraçar algo sem começar/terminar com espaço (como no WhatsApp).
      if (end < 0 || !inner || /^\s|\s$/.test(inner) || (key !== 'mono' && inner.includes('\n'))) continue
      flush()
      out.push(...(key === 'mono' ? [{ text: inner, ...style, mono: true }] : formatWhatsApp(inner, { ...style, [key]: true })))
      i = end + mark.length
      matched = true
      break
    }
    if (!matched) buf += text[i++]
  }
  flush()
  return out
}

// ---- operações no cache paginado -------------------------------------------------------------------------------

/** Acrescenta a mensagem no fim (página mais recente), sem duplicar. */
export function appendMessage(data: ThreadData, m: MessageDto): ThreadData {
  if (data.pages.some((p) => p.items.some((x) => x.id === m.id))) return patchMessage(data, m.id, m)
  const [first, ...rest] = data.pages
  if (!first) return { ...data, pages: [{ items: [m], next_cursor: null }] }
  return { ...data, pages: [{ ...first, items: [...first.items, m] }, ...rest] }
}

export function patchMessage(data: ThreadData, id: string, patch: Partial<MessageDto>): ThreadData {
  let hit = false
  const pages = data.pages.map((p) => ({
    ...p,
    items: p.items.map((x) => {
      if (x.id !== id) return x
      hit = true
      return { ...x, ...patch }
    }),
  }))
  return hit ? { ...data, pages } : data
}

/** Reação de um usuário: substitui a anterior dele (emoji vazio = remove). */
export function applyReaction(reactions: Reaction[] | undefined, r: { emoji: string; user_id: string | null; actor_type?: string }): Reaction[] {
  const rest = (reactions ?? []).filter((x) => !(x.user_id && x.user_id === r.user_id))
  return r.emoji ? [...rest, { emoji: r.emoji, user_id: r.user_id, actor_type: r.actor_type ?? 'user' }] : rest
}

export function findMessage(data: ThreadData | undefined, id: string): MessageDto | undefined {
  for (const p of data?.pages ?? []) for (const m of p.items) if (m.id === id) return m
  return undefined
}
