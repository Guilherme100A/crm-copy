// Regras puras do compositor (T85; spec 03 F31–F42, F48): limites de anexo (os mesmos do servidor, T49),
// formatação WhatsApp, atalho "/" das respostas rápidas, valor do Pix e o silêncio das notificações na gravação.

export type MediaKind = 'image' | 'video' | 'audio' | 'document'

const MB = 1024 * 1024

/** Limites por tipo (03-chats F32–F35; iguais ao `DEFAULT_MEDIA_LIMITS` da API). */
export const MEDIA_LIMITS: Readonly<Record<MediaKind, number>> = { image: 20 * MB, video: 20 * MB, audio: 16 * MB, document: 30 * MB }

/** Mimes aceitos pelo servidor (`ACCEPTED_MEDIA_MIMES`). */
export const ACCEPTED_MIMES: Readonly<Record<string, MediaKind>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'video/quicktime': 'video',
  'audio/ogg': 'audio',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/aac': 'audio',
  'audio/amr': 'audio',
  'audio/wav': 'audio',
  'audio/webm': 'audio',
  'audio/x-m4a': 'audio',
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'application/zip': 'document',
}

export const ACCEPT_ATTRIBUTE = Object.keys(ACCEPTED_MIMES).join(',')

const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase()

export type FileCheck = { ok: true; kind: MediaKind } | { ok: false; reason: 'unsupported' | 'too_large'; kind?: MediaKind; limit?: number }

/** Valida o arquivo antes de qualquer upload (AC-T85-02). */
export function checkFile(file: { type: string; size: number }): FileCheck {
  const kind = ACCEPTED_MIMES[baseMime(file.type || '')]
  if (!kind) return { ok: false, reason: 'unsupported' }
  if (file.size > MEDIA_LIMITS[kind]) return { ok: false, reason: 'too_large', kind, limit: MEDIA_LIMITS[kind] }
  return { ok: true, kind }
}

export const formatMb = (bytes: number) => `${Math.round(bytes / MB)} MB`

// ---- formatação ----------------------------------------------------------------------------------------------

export const FORMAT_MARKERS = { bold: '*', italic: '_', strike: '~' } as const
export type FormatKind = keyof typeof FORMAT_MARKERS

/** Envolve a seleção com o marcador; sem seleção, insere o par e põe o cursor no meio. */
export function wrapSelection(text: string, start: number, end: number, kind: FormatKind): { text: string; start: number; end: number } {
  const m = FORMAT_MARKERS[kind]
  const selected = text.slice(start, end)
  const next = `${text.slice(0, start)}${m}${selected}${m}${text.slice(end)}`
  return { text: next, start: start + 1, end: end + 1 }
}

/** O texto tem algum trecho formatado (para mostrar a prévia)? */
export const hasFormatting = (text: string) => /(\*[^\s*][^*\n]*\*|_[^\s_][^_\n]*_|~[^\s~][^~\n]*~|```[\s\S]+?```)/.test(text)

/** Insere `piece` na posição do cursor (emoji). */
export function insertAt(text: string, start: number, end: number, piece: string): { text: string; cursor: number } {
  return { text: `${text.slice(0, start)}${piece}${text.slice(end)}`, cursor: start + piece.length }
}

// ---- respostas rápidas ---------------------------------------------------------------------------------------

/** `/termo` no início do campo ou depois de espaço, terminando no cursor: `{ start, query }`; senão `null`. */
export function slashQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor)
  const m = /(^|\s)\/([^\s/]*)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2]!.length - 1, query: m[2]! }
}

/** Troca o `/termo` pelo texto da resposta rápida. */
export function replaceSlash(text: string, cursor: number, start: number, replacement: string): { text: string; cursor: number } {
  return { text: `${text.slice(0, start)}${replacement}${text.slice(cursor)}`, cursor: start + replacement.length }
}

// ---- Pix -----------------------------------------------------------------------------------------------------

/** "12,50" / "1.234,56" / "12.5" → centavos; vazio → null; inválido → NaN. */
export function parseAmountCents(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  let n = s.replace(/\s|R\$/gi, '')
  if (n.includes(',')) n = n.replace(/\./g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(n)) return Number.NaN
  return Math.round(Number(n) * 100)
}

// ---- sons de notificação --------------------------------------------------------------------------------------

/** Durante a gravação, as notificações sonoras ficam mudas (AC-T85-03): `body[data-notifications-muted]`. */
export function setNotificationsMuted(muted: boolean, root: { dataset: DOMStringMap } | undefined = globalThis.document?.body): void {
  if (!root) return
  if (muted) root.dataset.notificationsMuted = 'true'
  else delete root.dataset.notificationsMuted
}

/** Quem toca um som de notificação deve checar antes. */
export const isNotificationMuted = (root: { dataset: DOMStringMap } | undefined = globalThis.document?.body) => root?.dataset.notificationsMuted === 'true'

/** Assinatura persistida por usuário (localStorage). */
export const signatureKey = (userId: string | null | undefined) => `crm.chat.signature:${userId ?? 'anon'}`
