// Regras puras do editor de respostas rápidas (replicam `packages/core/src/content/rules.ts` e a validação do
// serviço da T35): atalho normalizado, 1–20 ações, config mínima por tipo e a ordem final 0..n−1.
import type { QrActionDto, QrActionType, QrMediaType, QuickReplyInput } from './api'

export const SHORTCUT_MAX = 60
export const MAX_ACTIONS = 20

/** Como o servidor: minúsculas, só `a-z 0-9 _ espaço -`, espaços colapsados e aparados. */
export function normalizeShortcut(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Ação no editor: `key` local estável para o arrasto (as ações novas ainda não têm id). */
export interface DraftAction {
  key: string
  type: QrActionType
  config: Record<string, unknown>
  /** Nome do arquivo enviado nesta sessão (só exibição). */
  fileName?: string
}

let seq = 0
export const draftKey = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`

export function emptyConfig(type: QrActionType): Record<string, unknown> {
  if (type === 'send_message') return { message_text: '' }
  if (type === 'send_multi_media') return { media_type: 'image', media_id: '', caption: '' }
  if (type === 'send_sticker') return { sticker_id: '' }
  return { contact_name: '', contact_phone: '' }
}

export const draftFromDto = (actions: readonly QrActionDto[]): DraftAction[] =>
  [...actions]
    .sort((a, b) => a.order - b.order)
    .map((a) => ({ key: a.id || draftKey(), type: a.type, config: { ...a.config } }))

/** Tipo da mídia pelo MIME (o servidor recusa `media_type` diferente do arquivo). */
export function mediaTypeOf(mime: string): QrMediaType {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  return 'document'
}

/** Move o item de `from` para `to` (cópia). Índices fora da faixa → mesma lista. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list]
  const out = [...list]
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item!)
  return out
}

const s = (v: unknown) => (typeof v === 'string' ? v : '')

export type DraftIssue = 'shortcut' | 'no_actions' | 'too_many' | { index: number; field: string }

/** Primeira pendência que o servidor recusaria (para avisar antes de enviar); `null` = ok. */
export function draftIssue(shortcut: string, actions: readonly DraftAction[]): DraftIssue | null {
  if (!normalizeShortcut(shortcut)) return 'shortcut'
  if (actions.length === 0) return 'no_actions'
  if (actions.length > MAX_ACTIONS) return 'too_many'
  for (const [index, a] of actions.entries()) {
    const c = a.config
    if (a.type === 'send_message' && !s(c.message_text).trim()) return { index, field: 'message_text' }
    if (a.type === 'send_multi_media' && !s(c.media_id)) return { index, field: 'media_id' }
    if (a.type === 'send_sticker' && !s(c.sticker_id)) return { index, field: 'sticker_id' }
    if (a.type === 'send_contact') {
      if (!s(c.contact_name).trim()) return { index, field: 'contact_name' }
      if (!s(c.contact_phone).trim()) return { index, field: 'contact_phone' }
    }
  }
  return null
}

/** Corpo do POST/PATCH: ordem pela posição na lista, só os campos do tipo. */
export function toInput(shortcut: string, actions: readonly DraftAction[]): QuickReplyInput {
  return {
    shortcut: normalizeShortcut(shortcut),
    actions: actions.map((a, order) => {
      const c = a.config
      let config: Record<string, unknown>
      if (a.type === 'send_message') config = { message_text: s(c.message_text) }
      else if (a.type === 'send_multi_media')
        config = {
          media_type: s(c.media_type) || 'image',
          media_id: s(c.media_id),
          ...(s(c.caption).trim() ? { caption: s(c.caption) } : {}),
        }
      else if (a.type === 'send_sticker') config = { sticker_id: s(c.sticker_id) }
      else config = { contact_name: s(c.contact_name).trim(), contact_phone: s(c.contact_phone).trim() }
      return { type: a.type, order, config }
    }),
  }
}
