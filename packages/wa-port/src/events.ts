// WaEvent v1 (SPEC 3.8): eventos do WhatsApp no Redis Stream `wsm:events`, JSON em snake_case no fio (SPEC 3.6).
// Entrega at-least-once; o CRM deduplica por (session_id, message_id). Campos novos só por acréscimo opcional
// (chaves desconhecidas são descartadas no parse), para que produtores mais novos não quebrem consumidores v1.
import * as z from 'zod'
import { DISCONNECT_KINDS, MESSAGE_STATUSES, SESSION_STATES } from './gateway'

export const WA_EVENT_VERSION = 1 as const
export const WA_EVENTS_STREAM = 'wsm:events'

export const WA_EVENT_TYPES = [
  'message.inbound',
  'message.status',
  'session.state',
  'session.connection',
  'session.qr',
  'session.pairing_code',
  'contact.upsert',
  'contact.lid_mapping',
  'presence.update',
  'history.batch',
] as const
export type WaEventType = (typeof WA_EVENT_TYPES)[number]

const id = z.string().min(1)
const isoDate = z.iso.datetime({ offset: true })

/** Mídia de uma mensagem recebida (MediaService do wa-engine, T21). */
export const mediaHandleSchema = z.object({
  session_id: id,
  message_id: id,
  mime: z.string().min(1),
  /** Bytes; null enquanto não baixada (download lazy). */
  size: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  /** Chave no BlobStore; null enquanto não baixada. */
  key: z.string().nullable(),
  /** `ready` = gravada no BlobStore; `pending` = download lazy; `unavailable` = expirada/falhou de vez (T21). */
  status: z.enum(['ready', 'pending', 'expired', 'failed', 'unavailable']),
  file_name: z.string().nullable().optional(),
})
export type MediaHandle = z.infer<typeof mediaHandleSchema>

/** Dados de anúncio Click-to-WhatsApp (contextInfo.externalAdReply). */
export const ctwaInfoSchema = z.object({
  ctwa_clid: z.string().nullable().optional(),
  source_id: z.string().nullable().optional(),
  source_type: z.string().nullable().optional(),
  source_url: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
})
export type CtwaInfo = z.infer<typeof ctwaInfoSchema>

/**
 * Mensagem recebida: forma do `IncomingMessage` do ai-manager em snake_case (`fromAlt` → `alt_jid`,
 * `fromMe` → `from_me`, `pushName` → `push_name`) + `media`, `quoted_id` e `ad`.
 */
export const incomingMessageSchema = z.object({
  /** ID da mensagem no WhatsApp. */
  id,
  /** JID do chat (contato ou grupo). */
  from: id,
  /** JID alternativo (PN quando o chat usa LID, e vice-versa). */
  alt_jid: z.string().optional(),
  /** Autor dentro de um grupo. */
  participant: z.string().optional(),
  from_me: z.boolean(),
  /** Epoch em milissegundos. */
  timestamp: z.number().int().nonnegative(),
  push_name: z.string().optional(),
  /** Texto (conversa, legenda ou texto estendido), quando houver. */
  text: z.string().optional(),
  /** Tipo do conteúdo (ex.: `conversation`, `imageMessage`). */
  type: z.string().min(1),
  media: mediaHandleSchema.optional(),
  /** Id da mensagem citada (resposta). */
  quoted_id: z.string().optional(),
  ad: ctwaInfoSchema.optional(),
  /** `true` = sincronizada (histórico ou enviada de outro aparelho): gravar sem disparar automações (T21/T33). */
  historical: z.literal(true).optional(),
})
export type IncomingMessage = z.infer<typeof incomingMessageSchema>

export const waContactSchema = z.object({
  jid: id,
  phone: z.string().nullable(),
  lid: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  push_name: z.string().nullable().optional(),
})
export type WaContact = z.infer<typeof waContactSchema>

const envelope = {
  v: z.literal(WA_EVENT_VERSION),
  session_id: id,
  /** Momento do fato (ISO 8601 UTC). */
  at: isoDate,
}

export const waEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('message.inbound'), message: incomingMessageSchema }),
  z.object({
    ...envelope,
    type: z.literal('message.status'),
    /** Id da mensagem no pipeline (MessageView.id). */
    message_id: id,
    transport_message_id: z.string().nullable().optional(),
    status: z.enum(MESSAGE_STATUSES),
    error: z.string().nullable().optional(),
  }),
  z.object({ ...envelope, type: z.literal('session.state'), from: z.enum(SESSION_STATES).nullable(), to: z.enum(SESSION_STATES) }),
  z.object({
    ...envelope,
    type: z.literal('session.connection'),
    state: z.enum(['open', 'close']),
    reason: z.enum(DISCONNECT_KINDS).optional(),
    status_code: z.number().int().optional(),
  }),
  /** QR como data URL PNG. */
  z.object({ ...envelope, type: z.literal('session.qr'), qr: z.string().min(1) }),
  z.object({ ...envelope, type: z.literal('session.pairing_code'), code: z.string().min(1) }),
  z.object({ ...envelope, type: z.literal('contact.upsert'), contact: waContactSchema }),
  /** Mapeamento LID ↔ PN: `lid` = `…@lid`, `pn` = telefone E.164. */
  z.object({ ...envelope, type: z.literal('contact.lid_mapping'), lid: id, pn: id }),
  z.object({
    ...envelope,
    type: z.literal('presence.update'),
    /** Chat (contato ou grupo) a que a presença se refere. */
    jid: id,
    participant: z.string().optional(),
    presence: z.enum(['available', 'unavailable', 'composing', 'recording', 'paused']),
    last_seen: z.number().int().nullable().optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal('history.batch'),
    sync_type: z.string().min(1).optional(),
    messages: z.array(incomingMessageSchema),
    is_latest: z.boolean().optional(),
    progress: z.number().nullable().optional(),
  }),
])
export type WaEvent = z.infer<typeof waEventSchema>
export type WaEventOf<T extends WaEventType> = Extract<WaEvent, { type: T }>

export class WaEventParseError extends Error {
  readonly code = 'INVALID_WA_EVENT'
  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'WaEventParseError'
  }
}

export type SafeParseWaEventResult = { success: true; data: WaEvent } | { success: false; error: WaEventParseError }

/**
 * O zod devolve as chaves na ordem do schema; reordena pela entrada para que o round-trip JSON seja idêntico
 * (os schemas não transformam valores, só descartam chaves desconhecidas).
 */
function inOrderOf<T>(parsed: T, original: unknown): T {
  if (Array.isArray(parsed)) {
    return (Array.isArray(original) ? parsed.map((item, i) => inOrderOf(item, original[i])) : parsed) as T
  }
  if (typeof parsed !== 'object' || parsed === null || typeof original !== 'object' || original === null) return parsed
  const src = parsed as Record<string, unknown>
  const orig = original as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(orig)) if (Object.hasOwn(src, key)) out[key] = inOrderOf(src[key], orig[key])
  for (const key of Object.keys(src)) if (!Object.hasOwn(out, key)) out[key] = src[key]
  return out as T
}

/** Valida um WaEvent v1 (objeto ou JSON). Nunca lança. */
export function safeParseWaEvent(input: unknown): SafeParseWaEventResult {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      return { success: false, error: new WaEventParseError('WaEvent is not valid JSON') }
    }
  }
  const version = typeof value === 'object' && value !== null ? (value as { v?: unknown }).v : undefined
  if (version !== WA_EVENT_VERSION) {
    return { success: false, error: new WaEventParseError(`unsupported WaEvent version: ${String(version)}`, [{ path: 'v', message: 'expected 1' }]) }
  }
  const parsed = waEventSchema.safeParse(value)
  if (parsed.success) return { success: true, data: inOrderOf(parsed.data, value) }
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
  const type = (value as { type?: unknown }).type
  return { success: false, error: new WaEventParseError(`invalid WaEvent${typeof type === 'string' ? ` (${type})` : ''}`, issues) }
}

/** Valida um WaEvent v1 (objeto ou JSON) e lança WaEventParseError se inválido ou de outra versão. */
export function parseWaEvent(input: unknown): WaEvent {
  const result = safeParseWaEvent(input)
  if (!result.success) throw result.error
  return result.data
}

export function isWaEventType(value: unknown): value is WaEventType {
  return typeof value === 'string' && (WA_EVENT_TYPES as readonly string[]).includes(value)
}
