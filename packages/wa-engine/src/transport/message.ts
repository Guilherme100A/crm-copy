// Conversão de WAMessage (Baileys rc14) → IncomingMessage, sem importar o Baileys (testável com objetos simples).
import type { CtwaInfo, IncomingMedia, IncomingMediaKind, IncomingMessage, LidMapping, WaContact, WaMessageKey } from './types'

/** Formato mínimo de uma WAMessage usado aqui. */
export interface RawMessage {
  key?: WaMessageKey | null
  message?: Record<string, unknown> | null
  messageTimestamp?: number | { toNumber(): number } | null
  pushName?: string | null
}

/** Invólucros cujo conteúdo real fica em `<wrapper>.message`. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const

const IGNORED_CONTENT_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

const MEDIA_KINDS: Record<string, IncomingMediaKind> = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
}

const DEFAULT_MIME: Record<IncomingMediaKind, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg; codecs=opus',
  document: 'application/octet-stream',
  sticker: 'image/webp',
}

/** Remove invólucros (temporária, visualização única, documento com legenda), como o `normalizeMessageContent`. */
export function unwrapContent(content: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  let current = content ?? undefined
  for (let depth = 0; current && depth < 5; depth++) {
    const wrapper = WRAPPERS.find((w) => current![w] != null)
    if (!wrapper) break
    const inner = (current[wrapper] as { message?: Record<string, unknown> | null } | null)?.message
    if (!inner) break
    current = inner
  }
  return current
}

/** Primeira chave de conteúdo real (ex.: `conversation`, `imageMessage`). */
export function contentType(content: Record<string, unknown> | undefined): string | undefined {
  if (!content) return undefined
  return Object.keys(content).find((k) => !IGNORED_CONTENT_KEYS.has(k) && content[k] != null)
}

const toNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

const toHex = (v: unknown): string | null => {
  if (typeof v === 'string') return v ? Buffer.from(v, 'base64').toString('hex') : null
  if (v instanceof Uint8Array) return v.length ? Buffer.from(v).toString('hex') : null
  return null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function mediaOf(type: string, body: Record<string, unknown>): IncomingMedia | undefined {
  const kind = MEDIA_KINDS[type]
  if (!kind) return undefined
  const media: IncomingMedia = {
    kind,
    mime: str(body.mimetype) ?? DEFAULT_MIME[kind],
    size: toNumber(body.fileLength) ?? null,
    sha256: toHex(body.fileSha256),
  }
  const fileName = str(body.fileName)
  if (fileName) media.file_name = fileName
  if (kind === 'audio' && body.ptt === true) media.ptt = true
  const seconds = toNumber(body.seconds)
  if (seconds !== undefined) media.seconds = seconds
  return media
}

/** `contextInfo` de qualquer corpo da mensagem. */
export function contextInfoOf(content: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  for (const body of Object.values(content ?? {})) {
    const ctx = (body as { contextInfo?: unknown } | null)?.contextInfo
    if (ctx && typeof ctx === 'object') return ctx as Record<string, unknown>
  }
  return undefined
}

/** Anúncio CTWA de `contextInfo.externalAdReply`; `undefined` sem `sourceId`/`ctwaClid`/`sourceUrl`. */
export function adFromContext(ctx: Record<string, unknown> | undefined): CtwaInfo | undefined {
  const ad = ctx?.externalAdReply as Record<string, unknown> | null | undefined
  if (!ad || typeof ad !== 'object') return undefined
  const sourceId = str(ad.sourceId)
  const ctwaClid = str(ad.ctwaClid)
  const sourceUrl = str(ad.sourceUrl)
  if (!sourceId && !ctwaClid && !sourceUrl) return undefined
  const info: CtwaInfo = { source_id: sourceId ?? null, ctwa_clid: ctwaClid ?? null, source_url: sourceUrl ?? null }
  const sourceType = str(ad.sourceType)
  const mediaUrl = str(ad.mediaUrl) ?? str(ad.thumbnailUrl) ?? str(ad.originalImageUrl)
  const title = str(ad.title)
  const body = str(ad.body)
  if (sourceType) info.source_type = sourceType
  if (mediaUrl) info.media_url = mediaUrl
  if (title) info.title = title
  if (body) info.body = body
  return info
}

/** `contextInfo.expiration` (conversas com mensagens temporárias). */
export function messageExpiration(content: Record<string, unknown> | null | undefined): number | undefined {
  for (const body of Object.values(unwrapContent(content) ?? {})) {
    const expiration = (body as { contextInfo?: { expiration?: unknown } } | null)?.contextInfo?.expiration
    if (typeof expiration === 'number' && expiration > 0) return expiration
  }
  return undefined
}

/** Converte uma WAMessage em `IncomingMessage`; `undefined` se não houver id, chat ou conteúdo. Nunca lança. */
export function toIncomingMessage(raw: RawMessage, opts: { historical?: boolean; now?: () => number } = {}): IncomingMessage | undefined {
  const key = raw.key ?? undefined
  const id = key?.id
  const from = key?.remoteJid
  const content = unwrapContent(raw.message)
  if (!id || !from || !content) return undefined
  const type = contentType(content)
  if (!type) return undefined

  const body = content[type]
  let text: string | undefined
  if (typeof body === 'string') text = body
  else if (body && typeof body === 'object') {
    const b = body as { text?: unknown; caption?: unknown }
    if (typeof b.text === 'string') text = b.text
    else if (typeof b.caption === 'string') text = b.caption
  }

  const seconds = toNumber(raw.messageTimestamp)
  const msg: IncomingMessage = {
    id,
    from,
    from_me: key.fromMe === true,
    timestamp: seconds !== undefined ? seconds * 1000 : (opts.now ?? Date.now)(),
    type,
    key: { ...key },
  }
  if (key.remoteJidAlt) msg.alt_jid = key.remoteJidAlt
  if (key.participant) msg.participant = key.participant
  if (key.participantAlt) msg.participant_alt = key.participantAlt
  if (raw.pushName) msg.push_name = raw.pushName
  if (text !== undefined) msg.text = text
  if (body && typeof body === 'object') {
    const media = mediaOf(type, body as Record<string, unknown>)
    if (media) msg.media = media
  }
  const ctx = contextInfoOf(content)
  const quoted = str(ctx?.stanzaId)
  if (quoted) msg.quoted_id = quoted
  const ad = adFromContext(ctx)
  if (ad) msg.ad = ad
  if (opts.historical) msg.historical = true
  return msg
}

/** JID sem o sufixo de dispositivo (`5511…:12@s.whatsapp.net` → `5511…@s.whatsapp.net`). */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, '@')
}

/** `5511999999999:12@s.whatsapp.net` → `+5511999999999`. LIDs e formatos desconhecidos → undefined. */
export function phoneFromUserJid(jid: string | null | undefined): string | undefined {
  const match = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')
  return match ? `+${match[1]}` : undefined
}

export const isLidJid = (jid: string | null | undefined): boolean => !!jid && jid.endsWith('@lid')

/** Par LID ↔ PN normalizado; `undefined` se faltar um dos lados. */
export function toLidMapping(raw: { lid?: string | null; pn?: string | null } | null | undefined): LidMapping | undefined {
  if (!raw?.lid || !raw.pn) return undefined
  const mapping: LidMapping = { lid: normalizeJid(raw.lid), pn: normalizeJid(raw.pn) }
  const phone = phoneFromUserJid(raw.pn)
  if (phone) mapping.phone = phone
  return mapping
}

export interface RawContact {
  id?: string | null
  lid?: string | null
  phoneNumber?: string | null
  name?: string | null
  notify?: string | null
}

/** Contact do Baileys v7 (`id` LID ou PN + `lid?` + `phoneNumber?`) → WaContact. */
export function toWaContact(raw: RawContact | null | undefined): WaContact | undefined {
  if (!raw?.id) return undefined
  const jid = normalizeJid(raw.id)
  const lid = raw.lid ? normalizeJid(raw.lid) : isLidJid(jid) ? jid : null
  const phone = phoneFromUserJid(raw.phoneNumber) ?? phoneFromUserJid(jid) ?? null
  const contact: WaContact = { jid, phone, lid }
  if (raw.name) contact.name = raw.name
  if (raw.notify) contact.push_name = raw.notify
  return contact
}
