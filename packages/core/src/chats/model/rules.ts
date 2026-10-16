// Regras puras do modelo de chats: status de entrega sem regressão, JIDs ignorados, tipos e prévia, opt-out.
import type { CrmMessageStatus } from '@crm/db'

/** Posição de cada status: um evento só avança. `failed`/`cancelled` só valem antes do envio. */
const RANK: Record<CrmMessageStatus, number> = {
  received: 0,
  queued: 1,
  processing: 2,
  retrying: 2,
  failed: 3,
  cancelled: 3,
  sent: 4,
  delivered: 5,
  read: 6,
}

/** O status `next` pode substituir `current`? Nunca regride (`read` não volta a `delivered`). */
export function canAdvanceStatus(current: CrmMessageStatus, next: CrmMessageStatus): boolean {
  if (current === next) return false
  if (current === 'failed' || current === 'cancelled') return RANK[next] > RANK.cancelled || next === 'retrying' || next === 'processing'
  return RANK[next] > RANK[current]
}

/** Grupos, status, transmissões e canais não entram no inbox do CRM (SPEC 3.8). */
export function isIgnoredJid(jid: string | null | undefined): boolean {
  if (!jid) return false
  return jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
}

const PHONE_JID = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/
const LID_JID = /^(\d{5,25})(?::\d+)?@lid$/

/** Identidade do contato a partir do chat (`from`) e do JID alternativo: telefone E.164 e/ou LID. */
export function identityOf(from: string, alt?: string | null): { phone: string | null; lid: string | null } {
  let phone: string | null = null
  let lid: string | null = null
  for (const jid of [from, alt]) {
    if (!jid) continue
    const p = PHONE_JID.exec(jid)
    if (p && !phone) phone = `+${p[1]}`
    const l = LID_JID.exec(jid)
    if (l && !lid) lid = `${l[1]}@lid`
  }
  return { phone, lid }
}

/** Tipos do WhatsApp que não viram mensagem no chat (controle, chaves, reações sem alvo). */
const SKIPPED_WA_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage'])

export const isSkippedWaType = (waType: string) => SKIPPED_WA_TYPES.has(waType)

const TYPE_MAP: Record<string, string> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  audioMessage: 'audio',
  videoMessage: 'video',
  ptvMessage: 'video',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contact',
  buttonsResponseMessage: 'text',
  listResponseMessage: 'text',
  templateButtonReplyMessage: 'text',
}

/** Tipo do CRM a partir do tipo do WhatsApp (`imageMessage` → `image`); desconhecido → `unknown`. */
export const crmMessageType = (waType: string) => TYPE_MAP[waType] ?? 'unknown'

const PREVIEW_LABEL: Record<string, string> = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎥 Vídeo',
  document: '📄 Documento',
  sticker: 'Figurinha',
  location: '📍 Localização',
  contact: '👤 Contato',
  unknown: 'Mensagem',
}

export function previewOf(type: string, text: string | null | undefined): string {
  const t = text?.trim()
  if (t) return t.length > 200 ? `${t.slice(0, 199)}…` : t
  return PREVIEW_LABEL[type] ?? 'Mensagem'
}

// ---- opt-out por palavra-chave (AC-T33-07) -------------------------------------------------------------------

export const DEFAULT_OPT_OUT_KEYWORDS = ['SAIR', 'PARAR', 'STOP', 'CANCELAR'] as const

/** Maiúsculas, sem acentos e sem pontuação/espaços nas pontas: `' parar! '` → `PARAR`. */
export function normalizeKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .replace(/\s+/g, ' ')
}

/**
 * Palavra de opt-out que a mensagem inteira representa (`null` se não for). A lista da empresa
 * (`companies.settings.opt_out_keywords`), quando definida, substitui a padrão.
 */
export function matchOptOutKeyword(text: string | null | undefined, keywords: readonly string[] = DEFAULT_OPT_OUT_KEYWORDS): string | null {
  if (!text) return null
  const normalized = normalizeKeyword(text)
  if (!normalized) return null
  return keywords.find((k) => normalizeKeyword(k) === normalized) ?? null
}

/** Lista efetiva da empresa a partir de `companies.settings`. */
export function optOutKeywordsFrom(settings: Record<string, unknown> | null | undefined): readonly string[] {
  const list = settings?.opt_out_keywords
  if (Array.isArray(list)) {
    const words = list.filter((w): w is string => typeof w === 'string' && w.trim() !== '')
    if (words.length) return words
  }
  return DEFAULT_OPT_OUT_KEYWORDS
}
