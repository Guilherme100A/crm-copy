// Envio, mídia, reação, apagar, encaminhar e leitura no chat (SPEC T49; 03-chats F31–F47).
// Todo envio passa por `WaGateway.send` (pipeline do engine: gates, fila, antiban; SPEC 1.4 nº 2). A mensagem do
// CRM é reservada (`queued`) antes do gateway, então uma repetição com a mesma Idempotency-Key nunca reenvia.
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { chatEvents, chats, connections, contacts, messageReactions, messages, type CrmMessageStatus, type Database } from '@crm/db'
import type { RealtimeEventData, RealtimeEventType } from '@crm/shared'
import type { MessageStatus, MessageView, OutgoingContent, PresenceKind, WaGateway } from '@crm/wa-port'
import type { ChatPublisher } from '../ingest/chat-ingest'
import { chatScope, toChatDto, toMessageDto, type ChatRow, type MessageDto, type MessageRow } from '../model/dto'
import { previewOf } from '../model/rules'
import { baseMime, blobUrl, MediaError, type MediaService } from '../../media/service'
import type { IdempotencyStore } from './idempotency'

export type ChatSendErrorCode = 'not_found' | 'validation' | 'conflict' | 'session_not_connected'

export class ChatSendError extends Error {
  constructor(
    readonly code: ChatSendErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ChatSendError'
  }
}

const invalid = (path: string, message: string) => new ChatSendError('validation', message, { fields: [{ path, message }] })

/**
 * Remetente de uma mensagem automática já enviada (T120): `flow` (nós de mensagem, T51) ou `system` (ação fora do
 * horário, T61). `flow` ainda não está em `MESSAGE_SENDER_TYPES` (@crm/db, T33): a coluna é texto livre, sem check.
 */
export type AutomaticSenderType = 'flow' | 'system'

export interface RecordOutboundInput {
  companyId: string
  /** Chat da mensagem; sem ele, o chat do contato na conexão da sessão (`contactId` + `sessionId`). */
  chatId?: string | null
  contactId?: string | null
  sessionId?: string | null
  senderType: AutomaticSenderType
  /** Quem pediu o envio (`flow:<runId>`, `crm:system:business-hours`); vai em `media.actor`. */
  actor: string
  content: OutgoingContent
  /** Mensagem aceita pelo gateway (`WaGateway.send`): a gravação é idempotente por `view.id`. */
  view: MessageView
  viewOnce?: boolean
}

/** Tipo, corpo e mídia do registro no CRM a partir do conteúdo enviado ao gateway. */
export function describeOutgoing(content: OutgoingContent): { type: string; body: string | null; media: Record<string, unknown> | null } {
  const c = content as Record<string, unknown>
  const blob = (ref: unknown, extra: Record<string, unknown>) => {
    const url = (ref as { url?: unknown } | undefined)?.url
    const key = typeof url === 'string' && url.startsWith('blob:') ? url.slice(5) : null
    return { ...(key ? { key } : typeof url === 'string' ? { url } : {}), ...extra }
  }
  const caption = (v: unknown) => (typeof v === 'string' && v ? v : null)
  if (typeof c.text === 'string') return { type: 'text', body: c.text, media: null }
  for (const kind of ['image', 'video', 'audio', 'document', 'sticker'] as const) {
    if (!(kind in c)) continue
    const extra: Record<string, unknown> = {}
    if (typeof c.mimetype === 'string') extra.mime = c.mimetype
    if (typeof c.fileName === 'string') extra.file_name = c.fileName
    if (c.ptt === true) extra.ptt = true
    return { type: kind, body: caption(c.caption), media: blob(c[kind], extra) }
  }
  if (c.contact && typeof c.contact === 'object') {
    const contact = c.contact as { displayName?: unknown; vcard?: unknown }
    return { type: 'contact', body: typeof contact.displayName === 'string' ? contact.displayName : null, media: { contact: { name: contact.displayName, vcard: contact.vcard } } }
  }
  if (c.location && typeof c.location === 'object') {
    const loc = c.location as { name?: unknown; address?: unknown }
    return { type: 'location', body: caption(loc.name) ?? caption(loc.address), media: { location: { ...(c.location as object) } } }
  }
  return { type: 'text', body: null, media: null }
}

/** Sessão do gateway de uma conexão do CRM (`crm.connections`, T40). `null` = sem sessão → 409. */
export type SessionResolver = (companyId: string, connectionId: string) => Promise<string | null>

/** Converte áudio em nota de voz Ogg/Opus mono (o `toPttOgg` da T12 tem esta forma). */
export type PttConverter = (data: Uint8Array, mime: string) => Promise<{ audio: Uint8Array; mime: string; seconds: number }>

export const SEND_MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'pix'] as const
export type SendMessageType = (typeof SEND_MESSAGE_TYPES)[number]

export interface SendMessageInput {
  type: SendMessageType
  text?: string | null
  mediaId?: string | null
  caption?: string | null
  /** Áudio como nota de voz (convertido para Ogg/Opus). */
  ptt?: boolean
  quotedId?: string | null
  viewOnce?: boolean
  location?: { latitude: number; longitude: number; name?: string | null; address?: string | null } | null
  contact?: { name: string; phone: string } | null
  pix?: { key: string; name?: string | null; amountCents?: number | null; code?: string | null } | null
  /** Prefixa `*Nome*:` no texto/legenda (assinatura do atendente). */
  signature?: boolean
}

export interface Sender {
  /** Usuário que envia; com `kind: 'ai'` não é gravado (o agente não é usuário). */
  userId: string
  name: string
  /** T68: `ai` = agente de IA (sender_type `ai`, actor `crm:ai:<agentId>`, sem auto-atribuição). Default `user`. */
  kind?: 'user' | 'ai'
  agentId?: string
}

const isAi = (s: Sender) => s.kind === 'ai'
const actorOf = (s: Sender) => (isAi(s) ? `crm:ai:${s.agentId ?? 'agent'}` : `crm:${s.userId}`)

export interface ChatSendServiceOptions {
  db: Database
  waGateway: Pick<WaGateway, 'send' | 'react' | 'deleteForEveryone' | 'presence'>
  resolveSession: SessionResolver
  media: MediaService
  pttConverter: PttConverter
  idempotency?: IdempotencyStore
  publisher?: ChatPublisher
  logger?: { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
  now?: () => Date
}

export const MESSAGES_PAGE_SIZE = 25

const PIPELINE_STATUS: Partial<Record<MessageStatus, CrmMessageStatus>> = {
  queued: 'queued',
  processing: 'processing',
  retrying: 'retrying',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Erro de envio rejeitado pelo pipeline (`SendRejectedError`) com o código da SPEC 3.5. */
const rejectionCode = (err: unknown): string | undefined =>
  err && typeof err === 'object' && (err as { name?: unknown }).name === 'SendRejectedError' ? String((err as { code?: unknown }).code) : undefined

const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** Pix vai como texto (SPEC 3.8): chave formatada e copia-e-cola. */
export function pixText(pix: NonNullable<SendMessageInput['pix']>): string {
  const lines = ['*Pagamento via Pix*', `Chave Pix: ${pix.key}`]
  if (pix.name) lines.push(`Recebedor: ${pix.name}`)
  if (pix.amountCents != null) lines.push(`Valor: ${brl(pix.amountCents)}`)
  if (pix.code) lines.push('', 'Pix copia e cola:', pix.code)
  return lines.join('\n')
}

/** vCard 3.0 do contato compartilhado. */
export function vcardOf(c: { name: string; phone: string }): string {
  const digits = c.phone.replace(/\D/g, '')
  const name = c.name.replace(/[\r\n;]/g, ' ').trim()
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`, 'END:VCARD'].join('\n')
}

const signed = (text: string, sender: Sender, on?: boolean) => (on ? `*${sender.name}*:\n${text}` : text)

interface Prepared {
  content: OutgoingContent
  type: string
  body: string | null
  media: Record<string, unknown> | null
  presence: PresenceKind | null
}

export class ChatSendService {
  private readonly db: Database
  private readonly now: () => Date

  constructor(private readonly opts: ChatSendServiceOptions) {
    this.db = opts.db
    this.now = opts.now ?? (() => new Date())
  }

  // ---- leitura ----------------------------------------------------------------------------------------------

  /** Histórico paginado (25 por página, da mais nova para trás); `before` = id da mais antiga já carregada. */
  async list(companyId: string, chatId: string, q: { before?: string; limit?: number } = {}): Promise<{ items: MessageWithReactions[]; next_cursor: string | null }> {
    await this.chat(companyId, chatId)
    const limit = Math.min(Math.max(q.limit ?? MESSAGES_PAGE_SIZE, 1), 100)
    const conds = [eq(messages.companyId, companyId), eq(messages.chatId, chatId)]
    if (q.before) {
      const [anchor] = await this.db.select({ createdAt: messages.createdAt, id: messages.id }).from(messages).where(and(eq(messages.companyId, companyId), eq(messages.chatId, chatId), eq(messages.id, q.before)))
      if (!anchor) throw invalid('before', 'Cursor inválido')
      conds.push(or(lt(messages.createdAt, anchor.createdAt), and(eq(messages.createdAt, anchor.createdAt), lt(messages.id, anchor.id)))!)
    }
    const rows = await this.db.select().from(messages).where(and(...conds)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit + 1)
    const page = rows.slice(0, limit)
    return { items: await this.withReactions(companyId, page.reverse().map(toMessageDto)), next_cursor: rows.length > limit ? page[0]!.id : null }
  }

  /** T75: reações gravadas de cada mensagem (`[{ emoji, actor_type, user_id }]`, da mais antiga para a mais nova). */
  private async withReactions(companyId: string, items: MessageDto[]): Promise<MessageWithReactions[]> {
    if (!items.length) return []
    const rows = await this.db
      .select({ messageId: messageReactions.messageId, emoji: messageReactions.emoji, actorType: messageReactions.actorType, userId: messageReactions.actorUserId })
      .from(messageReactions)
      .where(and(eq(messageReactions.companyId, companyId), inArray(messageReactions.messageId, items.map((m) => m.id))))
      .orderBy(messageReactions.createdAt)
    const by = new Map<string, MessageReactionDto[]>()
    for (const r of rows) {
      const list = by.get(r.messageId) ?? []
      list.push({ emoji: r.emoji, actor_type: r.actorType, user_id: r.userId })
      by.set(r.messageId, list)
    }
    return items.map((m) => ({ ...m, reactions: by.get(m.id) ?? [] }))
  }

  /**
   * T75: reenvia uma mensagem que falhou (mesmo conteúdo, pelo `WaGateway.send`). Só `failed` e de saída; volta a
   * `queued` e segue como um envio normal (se o gateway recusar de novo, volta a `failed` e o erro sobe).
   */
  async retry(companyId: string, chatId: string, messageId: string, sender: Sender): Promise<MessageDto> {
    const msg = await this.message(companyId, messageId, chatId)
    if (msg.direction !== 'outbound' || msg.status !== 'failed') throw new ChatSendError('conflict', 'Só mensagens com falha podem ser reenviadas', { status: msg.status })
    const prepared = this.preparedFrom(msg)
    if (!prepared) throw new ChatSendError('conflict', 'Mensagem sem conteúdo reenviável')
    const { chat, phone, sessionId } = await this.target(companyId, chatId)
    await this.db.update(messages).set({ status: 'queued', error: null, updatedAt: this.now() }).where(eq(messages.id, msg.id))
    await this.publish(companyId, 'message.status', { chat_id: chat.id, message_id: msg.id, status: 'queued', error: null }, chat)
    const viewOnce = (msg.media as Record<string, unknown> | null)?.view_once === true
    let view
    try {
      view = await this.opts.waGateway.send({ sessionId, phone, content: prepared.content, actor: actorOf(sender), ...(viewOnce ? { viewOnce: true } : {}) })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      await this.db.update(messages).set({ status: 'failed', error, updatedAt: this.now() }).where(eq(messages.id, msg.id))
      await this.publish(companyId, 'message.status', { chat_id: chat.id, message_id: msg.id, status: 'failed', error }, chat)
      throw err
    }
    const [sent] = await this.db
      .update(messages)
      .set({
        status: PIPELINE_STATUS[view.status] ?? 'queued',
        pipelineMessageId: view.id,
        ...(view.transportMessageId ? { waMessageId: view.transportMessageId } : {}),
        ...(view.sentAt ? { sentAt: new Date(view.sentAt) } : {}),
        updatedAt: this.now(),
      })
      .where(eq(messages.id, msg.id))
      .returning()
    await this.publish(companyId, 'message.status', { chat_id: chat.id, message_id: msg.id, status: sent!.status, error: null }, chat)
    return toMessageDto(sent!)
  }

  /** Conteúdo do gateway reconstruído do registro (reenvio): mídia pelo blob, localização, contato ou texto. */
  private preparedFrom(msg: MessageRow): Prepared | null {
    const media = (msg.media ?? null) as Record<string, unknown> | null
    const sha = typeof media?.key === 'string' ? media.key : typeof media?.sha256 === 'string' ? media.sha256 : null
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(msg.type) && sha && typeof media?.mime === 'string')
      return this.mediaContent(msg.type, { sha256: sha, mime: media.mime, fileName: typeof media.file_name === 'string' ? media.file_name : null }, msg.body, media.ptt === true)
    const loc = media?.location as { latitude?: number; longitude?: number; name?: string | null; address?: string | null } | undefined
    if (msg.type === 'location' && typeof loc?.latitude === 'number' && typeof loc.longitude === 'number')
      return {
        content: { location: { latitude: loc.latitude, longitude: loc.longitude, ...(loc.name ? { name: loc.name } : {}), ...(loc.address ? { address: loc.address } : {}) } },
        type: 'location',
        body: msg.body,
        media,
        presence: null,
      }
    const contact = media?.contact as { name?: string; phone?: string } | undefined
    if (msg.type === 'contact' && contact?.name && contact.phone) {
      const c = { name: contact.name, phone: contact.phone }
      return { content: { contact: { displayName: c.name, vcard: vcardOf(c) } }, type: 'contact', body: msg.body, media, presence: null }
    }
    if (msg.body?.trim()) return { content: { text: msg.body }, type: 'text', body: msg.body, media: null, presence: null }
    return null
  }

  /** Marca o chat como lido (zera não lidas). */
  async markRead(companyId: string, chatId: string): Promise<ChatRow> {
    const chat = await this.chat(companyId, chatId)
    if (chat.unreadCount === 0) return chat
    const [updated] = await this.db.update(chats).set({ unreadCount: 0, updatedAt: this.now() }).where(eq(chats.id, chat.id)).returning()
    await this.publish(companyId, 'chat.updated', { chat_id: chat.id, chat: toChatDto(updated!) as never }, updated!)
    return updated!
  }

  // ---- envio ------------------------------------------------------------------------------------------------

  /**
   * Envia uma mensagem no chat. Com `idempotencyKey`, a repetição devolve a mesma mensagem (`replay: true`) sem
   * chamar o gateway. Sessão desconectada → 409 e nada fica gravado. Outra falha do gateway → mensagem `failed`.
   */
  async send(companyId: string, chatId: string, sender: Sender, input: SendMessageInput, idempotencyKey?: string | null): Promise<{ message: MessageDto; replay: boolean }> {
    const key = idempotencyKey ? `${companyId}:${idempotencyKey}` : null
    if (key && this.opts.idempotency) {
      const claim = await this.waitClaim(key)
      if (claim) return { message: toMessageDto(await this.message(companyId, claim)), replay: true }
    }
    try {
      const message = await this.doSend(companyId, chatId, sender, input, idempotencyKey ?? null)
      if (key) await this.opts.idempotency?.complete(key, message.id)
      return { message, replay: false }
    } catch (err) {
      // Nada foi criado (validação, sessão desconectada): a mesma chave pode tentar de novo.
      if (key && !(err instanceof FailedSend)) await this.opts.idempotency?.release(key)
      if (err instanceof FailedSend) {
        if (key) await this.opts.idempotency?.complete(key, err.messageId)
        throw err.cause
      }
      throw err
    }
  }

  /**
   * Grava no chat uma mensagem automática que JÁ foi enviada pelo gateway (nó de fluxo ou ação fora do horário), sem
   * reenviar. Idempotente por `view.id` (`messages_company_pipeline_id_uq`): o retry do passo do fluxo devolve a mesma
   * linha. Atualiza a prévia do chat (sem atribuir atendente) e publica `message.created`/`chat.updated`.
   * Sem chat encontrado devolve `null` (ex.: run manual de contato sem chat na conexão).
   */
  async recordOutbound(input: RecordOutboundInput): Promise<MessageDto | null> {
    const chat = await this.chatForRecord(input)
    if (!chat) return null
    const described = describeOutgoing(input.content)
    const view = input.view
    const now = this.now()
    const media = { ...(described.media ?? {}), actor: input.actor, ...(input.viewOnce ? { view_once: true } : {}) }
    const result = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(messages)
        .values({
          companyId: input.companyId,
          chatId: chat.id,
          direction: 'outbound',
          // `flow` fora da união do @crm/db (T33): texto livre no banco.
          senderType: input.senderType as never,
          senderUserId: null,
          type: described.type,
          body: described.body,
          media,
          status: PIPELINE_STATUS[view.status] ?? 'queued',
          pipelineMessageId: view.id,
          ...(view.transportMessageId ? { waMessageId: view.transportMessageId } : {}),
          ...(view.sentAt ? { sentAt: new Date(view.sentAt) } : {}),
        })
        .onConflictDoNothing()
        .returning()
      if (!inserted) return null
      const [updatedChat] = await tx
        .update(chats)
        .set({ lastMessageAt: now, lastMessagePreview: previewOf(described.type, described.body), updatedAt: now })
        .where(eq(chats.id, chat.id))
        .returning()
      return { msg: inserted, chat: updatedChat! }
    })
    if (!result) {
      // Repetição: devolve a linha já gravada.
      const [existing] = await this.db
        .select()
        .from(messages)
        .where(and(eq(messages.companyId, input.companyId), eq(messages.pipelineMessageId, view.id)))
        .limit(1)
      return existing ? toMessageDto(existing) : null
    }
    await this.publish(input.companyId, 'message.created', { chat_id: chat.id, message: toMessageDto(result.msg) as never }, result.chat)
    await this.publish(input.companyId, 'chat.updated', { chat_id: chat.id, chat: toChatDto(result.chat) as never }, result.chat)
    return toMessageDto(result.msg)
  }

  private async chatForRecord(input: RecordOutboundInput): Promise<ChatRow | null> {
    if (input.chatId) {
      const [row] = await this.db.select().from(chats).where(and(eq(chats.companyId, input.companyId), eq(chats.id, input.chatId))).limit(1)
      return row ?? null
    }
    if (!input.contactId || !input.sessionId) return null
    const [row] = await this.db
      .select({ chat: chats })
      .from(chats)
      .innerJoin(connections, eq(connections.id, chats.connectionId))
      .where(and(eq(chats.companyId, input.companyId), eq(chats.contactId, input.contactId), eq(connections.sessionId, input.sessionId)))
      .limit(1)
    return row?.chat ?? null
  }

  /** Encaminha a mensagem para outro chat da empresa (mesmo conteúdo). */
  async forward(companyId: string, chatId: string, messageId: string, targetChatId: string, sender: Sender): Promise<MessageDto> {
    const original = await this.message(companyId, messageId, chatId)
    const media = original.media as { key?: string; sha256?: string; mime?: string; file_name?: string; ptt?: boolean } | null
    const sha = media?.key ?? media?.sha256
    const input: SendMessageInput = { type: 'text', text: original.body }
    // Mídia: reaproveita o blob original (endereçado por conteúdo); texto vai como texto.
    const prepared: Prepared | null =
      sha && media?.mime
        ? this.mediaContent(original.type, { sha256: sha, mime: media.mime, fileName: media.file_name ?? null }, original.body, !!media.ptt)
        : null
    if (!prepared && !original.body) throw invalid('message_id', 'Mensagem sem conteúdo encaminhável')
    const content = prepared ?? { content: { text: original.body! }, type: 'text', body: original.body, media: null, presence: 'composing' as const }
    return this.doSend(companyId, targetChatId, sender, input, null, content)
  }

  async react(companyId: string, chatId: string, messageId: string, emoji: string, sender: Sender): Promise<MessageDto> {
    const { chat, phone, sessionId } = await this.target(companyId, chatId)
    const msg = await this.message(companyId, messageId, chatId)
    if (!msg.waMessageId) throw new ChatSendError('conflict', 'A mensagem ainda não tem id do WhatsApp')
    await this.opts.waGateway.react({ sessionId, phone, messageId: msg.waMessageId, emoji, actor: `crm:${sender.userId}` })
    await this.db.transaction(async (tx) => {
      await tx.delete(messageReactions).where(and(eq(messageReactions.messageId, msg.id), eq(messageReactions.actorUserId, sender.userId)))
      if (emoji) await tx.insert(messageReactions).values({ companyId, messageId: msg.id, actorType: 'user', actorUserId: sender.userId, emoji })
    })
    await this.publish(companyId, 'message.reacted', { chat_id: chat.id, message_id: msg.id, emoji, user_id: sender.userId }, chat)
    return toMessageDto(msg)
  }

  /** Apagar para todos (só mensagens enviadas pela conta). */
  async deleteForEveryone(companyId: string, chatId: string, messageId: string, sender: Sender): Promise<MessageDto> {
    const { chat, phone, sessionId } = await this.target(companyId, chatId)
    const msg = await this.message(companyId, messageId, chatId)
    if (msg.direction !== 'outbound') throw new ChatSendError('conflict', 'Só mensagens enviadas pela conta podem ser apagadas para todos')
    if (!msg.waMessageId) throw new ChatSendError('conflict', 'A mensagem ainda não tem id do WhatsApp')
    if (msg.deletedAt) return toMessageDto(msg)
    await this.opts.waGateway.deleteForEveryone({ sessionId, phone, messageId: msg.waMessageId, actor: `crm:${sender.userId}` })
    const [updated] = await this.db.update(messages).set({ deletedAt: this.now(), updatedAt: this.now() }).where(eq(messages.id, msg.id)).returning()
    await this.publish(companyId, 'message.deleted', { chat_id: chat.id, message_id: msg.id }, chat)
    return toMessageDto(updated!)
  }

  // ---- internos ---------------------------------------------------------------------------------------------

  /** Espera a 1ª requisição com a mesma chave terminar (até ~5 s). Devolve o id já criado, ou `null` se é nova. */
  private async waitClaim(key: string): Promise<string | null> {
    for (let i = 0; i < 50; i++) {
      const claim = await this.opts.idempotency!.claim(key)
      if (claim.state === 'new') return null
      if (claim.state === 'done') return claim.messageId
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new ChatSendError('conflict', 'Requisição com a mesma Idempotency-Key ainda em andamento')
  }

  private async doSend(
    companyId: string,
    chatId: string,
    sender: Sender,
    input: SendMessageInput,
    clientMessageId: string | null,
    preparedOverride?: Prepared,
  ): Promise<MessageDto> {
    const { chat, phone, sessionId } = await this.target(companyId, chatId)
    const prepared = preparedOverride ?? (await this.prepare(companyId, sender, input))
    let quoted: string | null = null
    if (input.quotedId) quoted = (await this.message(companyId, input.quotedId, chatId)).waMessageId

    // Reserva a mensagem antes do gateway (status `queued`, o "pending" do produto).
    const [reserved] = await this.db
      .insert(messages)
      .values({
        companyId,
        chatId: chat.id,
        direction: 'outbound',
        senderType: isAi(sender) ? 'ai' : 'user',
        senderUserId: isAi(sender) ? null : sender.userId,
        type: prepared.type,
        body: prepared.body,
        media: prepared.media ? { ...prepared.media, ...(input.viewOnce ? { view_once: true } : {}), ...(clientMessageId ? { client_message_id: clientMessageId } : {}) } : clientMessageId ? { client_message_id: clientMessageId } : null,
        quotedWaMessageId: quoted,
        status: 'queued',
      })
      .returning()

    if (prepared.presence) await this.opts.waGateway.presence(sessionId, phone, prepared.presence).catch(() => undefined)
    let view
    try {
      // `contactId` do SendRequest é o id do contato no engine (public.contacts), não o do CRM: não se envia.
      view = await this.opts.waGateway.send({ sessionId, phone, content: prepared.content, actor: actorOf(sender) })
    } catch (err) {
      if (rejectionCode(err) === 'SESSION_NOT_CONNECTED') {
        // A mensagem não chegou a ser aceita: nada fica gravado (AC-T49-06).
        await this.db.delete(messages).where(eq(messages.id, reserved!.id))
        throw err
      }
      const [failed] = await this.db
        .update(messages)
        .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), updatedAt: this.now() })
        .where(eq(messages.id, reserved!.id))
        .returning()
      await this.publish(companyId, 'message.created', { chat_id: chat.id, message: toMessageDto(failed!) as never }, chat)
      await this.publish(companyId, 'message.status', { chat_id: chat.id, message_id: failed!.id, status: 'failed', error: failed!.error }, chat)
      throw new FailedSend(failed!.id, err)
    }

    const now = this.now()
    const result = await this.db.transaction(async (tx) => {
      const [msg] = await tx
        .update(messages)
        .set({
          status: PIPELINE_STATUS[view.status] ?? 'queued',
          pipelineMessageId: view.id,
          ...(view.transportMessageId ? { waMessageId: view.transportMessageId } : {}),
          ...(view.sentAt ? { sentAt: new Date(view.sentAt) } : {}),
          updatedAt: now,
        })
        .where(eq(messages.id, reserved!.id))
        .returning()
      const [current] = await tx.select().from(chats).where(eq(chats.id, chat.id)).for('update')
      const set: Partial<typeof chats.$inferInsert> = { lastMessageAt: now, lastMessagePreview: previewOf(prepared.type, prepared.body), updatedAt: now }
      // Auto-atribuição (F20): responder um chat da fila sem responsável assume o atendimento.
      // O agente de IA não assume o chat nem conta como primeira resposta humana (T68).
      if (!isAi(sender) && !current!.assignedUserId && current!.status === 'waiting') {
        Object.assign(set, { assignedUserId: sender.userId, status: 'attending' })
        await tx.insert(chatEvents).values({ companyId, chatId: chat.id, type: 'assigned', actorUserId: sender.userId, detail: { reason: 'first_reply' } })
      }
      if (!isAi(sender) && !current!.firstHumanReplyAt) Object.assign(set, { firstHumanReplyAt: now, firstHumanReplyBy: sender.userId })
      const [updatedChat] = await tx.update(chats).set(set).where(eq(chats.id, chat.id)).returning()
      return { msg: msg!, chat: updatedChat! }
    })
    await this.publish(companyId, 'message.created', { chat_id: chat.id, message: toMessageDto(result.msg) as never }, result.chat)
    await this.publish(companyId, 'chat.updated', { chat_id: chat.id, chat: toChatDto(result.chat) as never }, result.chat)
    return toMessageDto(result.msg)
  }

  /** Conteúdo para o gateway, corpo e mídia do registro no CRM. */
  private async prepare(companyId: string, sender: Sender, input: SendMessageInput): Promise<Prepared> {
    switch (input.type) {
      case 'text': {
        const text = input.text?.trim()
        if (!text) throw invalid('text', 'Texto obrigatório')
        const body = signed(input.text!, sender, input.signature)
        return { content: { text: body }, type: 'text', body, media: null, presence: 'composing' }
      }
      case 'pix': {
        if (!input.pix?.key?.trim()) throw invalid('pix.key', 'Chave Pix obrigatória')
        const body = pixText(input.pix)
        return { content: { text: body }, type: 'text', body, media: null, presence: 'composing' }
      }
      case 'location': {
        const loc = input.location
        if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) throw invalid('location', 'Localização inválida')
        const content: OutgoingContent = {
          location: { latitude: loc.latitude, longitude: loc.longitude, ...(loc.name ? { name: loc.name } : {}), ...(loc.address ? { address: loc.address } : {}) },
        }
        return { content, type: 'location', body: loc.name ?? loc.address ?? null, media: { location: { ...loc } }, presence: null }
      }
      case 'contact': {
        const c = input.contact
        if (!c?.name?.trim() || !/\d{8,15}/.test(c.phone.replace(/\D/g, ''))) throw invalid('contact', 'Contato inválido')
        return { content: { contact: { displayName: c.name.trim(), vcard: vcardOf(c) } }, type: 'contact', body: c.name.trim(), media: { contact: { ...c } }, presence: null }
      }
      default: {
        if (!input.mediaId) throw invalid('media_id', 'Mídia obrigatória')
        let media
        try {
          media = await this.opts.media.get(companyId, input.mediaId)
        } catch (err) {
          if (err instanceof MediaError) throw invalid('media_id', 'Mídia não encontrada')
          throw err
        }
        const kindOk =
          (input.type === 'image' && media.kind === 'image') ||
          (input.type === 'sticker' && baseMime(media.mime) === 'image/webp') ||
          (input.type === 'video' && media.kind === 'video') ||
          (input.type === 'audio' && media.kind === 'audio') ||
          (input.type === 'document' && (media.kind === 'document' || media.kind === 'image' || media.kind === 'video' || media.kind === 'audio'))
        if (!kindOk) throw invalid('media_id', `Mídia incompatível com o tipo ${input.type}`)
        const caption = input.caption?.trim() ? signed(input.caption, sender, input.signature) : null
        if (input.type === 'audio' && input.ptt) {
          // Nota de voz: sempre Ogg/Opus mono (conversor injetado; o padrão é o ffmpeg da T12).
          const converted = await this.opts.pttConverter(media.data, media.mime)
          const stored = await this.opts.media.store(companyId, converted.audio, converted.mime)
          const prepared = this.mediaContent('audio', { sha256: stored.sha256, mime: converted.mime, fileName: null }, null, true)
          return { ...prepared, media: { ...prepared.media, seconds: converted.seconds } }
        }
        return this.mediaContent(input.type, { sha256: media.sha256, mime: media.mime, fileName: media.file_name }, caption, false)
      }
    }
  }

  private mediaContent(type: string, m: { sha256: string; mime: string; fileName: string | null }, caption: string | null, ptt: boolean): Prepared {
    const ref = { url: blobUrl(m.sha256) }
    const base = { key: m.sha256, mime: m.mime, ...(m.fileName ? { file_name: m.fileName } : {}) }
    switch (type) {
      case 'image':
        return { content: { image: ref, mimetype: m.mime, ...(caption ? { caption } : {}) }, type, body: caption, media: base, presence: null }
      case 'video':
        return { content: { video: ref, mimetype: m.mime, ...(caption ? { caption } : {}) }, type, body: caption, media: base, presence: null }
      case 'audio':
        return { content: { audio: ref, mimetype: m.mime, ...(ptt ? { ptt: true } : {}) }, type, body: null, media: { ...base, ...(ptt ? { ptt: true } : {}) }, presence: 'recording' }
      case 'sticker':
        return { content: { sticker: ref }, type, body: null, media: base, presence: null }
      default:
        return {
          content: { document: ref, mimetype: m.mime, ...(m.fileName ? { fileName: m.fileName } : {}), ...(caption ? { caption } : {}) },
          type: 'document',
          body: caption,
          media: base,
          presence: null,
        }
    }
  }

  private async chat(companyId: string, chatId: string): Promise<ChatRow> {
    const [row] = /^[0-9a-f-]{36}$/i.test(chatId) ? await this.db.select().from(chats).where(and(eq(chats.companyId, companyId), eq(chats.id, chatId))) : []
    if (!row) throw new ChatSendError('not_found', 'Chat não encontrado')
    return row
  }

  private async message(companyId: string, messageId: string, chatId?: string): Promise<MessageRow> {
    const conds = [eq(messages.companyId, companyId), eq(messages.id, messageId)]
    if (chatId) conds.push(eq(messages.chatId, chatId))
    const [row] = /^[0-9a-f-]{36}$/i.test(messageId) ? await this.db.select().from(messages).where(and(...conds)) : []
    if (!row) throw new ChatSendError('not_found', 'Mensagem não encontrada')
    return row
  }

  /** Chat, telefone do contato e sessão do gateway. */
  private async target(companyId: string, chatId: string): Promise<{ chat: ChatRow; phone: string; sessionId: string }> {
    const chat = await this.chat(companyId, chatId)
    const [contact] = await this.db.select({ phone: contacts.phoneE164 }).from(contacts).where(eq(contacts.id, chat.contactId))
    if (!contact?.phone) throw new ChatSendError('conflict', 'O contato não tem telefone (só LID); aguarde o mapeamento do WhatsApp')
    const sessionId = await this.opts.resolveSession(companyId, chat.connectionId)
    if (!sessionId) throw new ChatSendError('session_not_connected', 'Conexão sem sessão ativa')
    return { chat, phone: contact.phone, sessionId }
  }

  private async publish<T extends RealtimeEventType>(companyId: string, type: T, data: RealtimeEventData<T>, chat: ChatRow): Promise<void> {
    if (!this.opts.publisher) return
    try {
      await this.opts.publisher.publish(companyId, type, data, { scope: chatScope(chat) })
    } catch (err) {
      this.opts.logger?.error({ err, company_id: companyId, type }, 'falha ao publicar evento realtime')
    }
  }
}

/** Falha do gateway depois de a mensagem existir (`failed`): a chave de idempotência aponta para ela. */
class FailedSend extends Error {
  constructor(
    readonly messageId: string,
    override readonly cause: unknown,
  ) {
    super('falha no envio')
  }
}

/** Sessão do gateway via `crm.connections(id, company_id, session_id)` (T40); `null` se não houver. */
export function crmConnectionSessionResolver(db: Database): SessionResolver {
  return async (companyId, connectionId) => {
    try {
      const res = await db.execute(sql`select session_id from crm.connections where company_id = ${companyId} and id = ${connectionId} limit 1`)
      return ((res.rows[0] as { session_id?: string } | undefined)?.session_id ?? null) || null
    } catch (err) {
      if ((err as { code?: unknown; cause?: { code?: unknown } }).code === '42P01' || (err as { cause?: { code?: unknown } }).cause?.code === '42P01') return null
      throw err
    }
  }
}

/** T75: reação gravada de uma mensagem. */
export interface MessageReactionDto {
  emoji: string
  actor_type: string
  user_id: string | null
}

export type MessageWithReactions = MessageDto & { reactions: MessageReactionDto[] }
