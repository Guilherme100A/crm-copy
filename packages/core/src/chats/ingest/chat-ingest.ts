// Ingestão dos eventos WhatsApp (WaEvent v1) em contatos, chats e mensagens do CRM (SPEC T33; 03-chats).
// Idempotente: a mensagem é única por (empresa, wa_message_id), então reentregas não duplicam nem recontam.
// Mensagens de grupo, status e canais são ignoradas (SPEC 3.8). Opt-out por palavra-chave bloqueia na hora (1.4 nº 3).
// Revisão 3 (rastreamento Meta): mensagem ao vivo com referral de anúncio (`ctwa_clid`) grava o toque de atribuição;
// mensagem com código de link rastreável (`(ref XXXXXX)`) liga o clique ao contato e é gravada sem o código. Nos dois
// casos o `crm.inbound` sai com `ad_source` (o worker usa para o Lead automático de anúncio).
import { and, asc, eq, sql } from 'drizzle-orm'
import { auditLogs, chatEvents, chats, companies, messages, type CrmMessageStatus, type Database } from '@crm/db'
import type { RealtimeEventData, RealtimeEventType } from '@crm/shared'
import type { IncomingMessage, WaEvent, WaEventOf, WaGateway } from '@crm/wa-port'
import { AttributionService, recordAttributionEvidence } from '../../attribution/service'
import { ContactsError } from '../../contacts/errors'
import { TrackedLinksService } from '../../meta-capi/tracked-links'
import { ContactsService, type ContactDto } from '../../contacts/service'
import { chatScope, toChatDto, toMessageDto, type ChatRow, type MessageRow } from '../model/dto'
import { crmConnectionsResolver, type ConnectionResolver, type ResolvedConnection } from '../model/connections'
import { mergeContactChats } from '../model/merge'
import {
  canAdvanceStatus,
  crmMessageType,
  identityOf,
  isIgnoredJid,
  isSkippedWaType,
  matchOptOutKeyword,
  optOutKeywordsFrom,
  previewOf,
} from '../model/rules'

/** Publicador realtime (o `RealtimePublisher` da T16 serve). */
export interface ChatPublisher {
  publish<T extends RealtimeEventType>(companyId: string, type: T, data: RealtimeEventData<T>, opts?: { scope?: Record<string, unknown> }): Promise<unknown>
}

/** Evento interno `crm.inbound` (não vai ao SSE): mensagem nova de contato, para fluxos e agentes. */
export interface CrmInboundEvent {
  company_id: string
  connection_id: string
  session_id: string
  chat_id: string
  contact_id: string
  message_id: string
  wa_message_id: string
  type: string
  text: string | null
  from_me: false
  chat_created: boolean
  chat_reopened: boolean
  /** A mensagem veio de anúncio: `ctwa` (clique para WhatsApp) ou `link` (link rastreável, 1ª ligação do clique). */
  ad_source?: 'ctwa' | 'link' | null
}

export interface ChatIngestLogger {
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface ChatIngestOptions {
  db: Database
  publisher?: ChatPublisher
  /** Consentimento `inbound` e opt-out. Ausente: as chamadas ao gateway são puladas. */
  waGateway?: Pick<WaGateway, 'recordConsent' | 'optOut'>
  /** Sessão → empresa/conexão. Padrão: `crm.connections` (T40). */
  resolveConnection?: ConnectionResolver
  /** `crm.inbound`: chamado depois do commit para cada mensagem nova de contato (não histórica). */
  onInbound?: (e: CrmInboundEvent) => void | Promise<void>
  logger?: ChatIngestLogger
  now?: () => Date
}

export type IngestOutcome =
  | { status: 'ignored'; reason: string }
  | { status: 'duplicate'; chatId: string; messageId: string }
  | { status: 'stored'; chatId: string; messageId: string; chatCreated: boolean; contactCreated: boolean }
  | { status: 'updated' }

const noopLogger: ChatIngestLogger = { warn: () => undefined, error: () => undefined }

export class ChatIngest {
  readonly contacts: ContactsService
  private readonly db: Database
  private readonly resolve: ConnectionResolver
  private readonly log: ChatIngestLogger
  private readonly now: () => Date

  constructor(private readonly opts: ChatIngestOptions) {
    this.db = opts.db
    this.resolve = opts.resolveConnection ?? crmConnectionsResolver(opts.db)
    this.log = opts.logger ?? noopLogger
    this.now = opts.now ?? (() => new Date())
    this.contacts = new ContactsService({
      db: opts.db,
      ...(opts.waGateway ? { waGateway: opts.waGateway } : {}),
      mergeHooks: [async (tx, e) => void (await mergeContactChats(tx, e))],
    })
  }

  /** Trata um WaEvent v1. Tipos que não são do módulo de chats são ignorados. */
  async handle(event: WaEvent): Promise<IngestOutcome | IngestOutcome[]> {
    switch (event.type) {
      case 'message.inbound': {
        const historical = (event.message as IncomingMessage & { historical?: unknown }).historical === true
        return this.ingestMessage(event.session_id, event.message, historical)
      }
      case 'history.batch': {
        const out: IngestOutcome[] = []
        for (const m of event.messages) out.push(await this.ingestMessage(event.session_id, m, true))
        return out
      }
      case 'message.status':
        return this.applyStatus(event)
      case 'contact.upsert':
        return this.contactUpsert(event)
      case 'contact.lid_mapping':
        return this.lidMapping(event)
      default:
        return { status: 'ignored', reason: 'type' }
    }
  }

  // ---- message.inbound / history.batch --------------------------------------------------------------------

  private async ingestMessage(sessionId: string, m: IncomingMessage, historical: boolean): Promise<IngestOutcome> {
    if (isIgnoredJid(m.from) || isIgnoredJid(m.alt_jid) || m.participant) return { status: 'ignored', reason: 'group_or_broadcast' }
    if (isSkippedWaType(m.type)) return { status: 'ignored', reason: 'wa_type' }
    const conn = await this.resolve(sessionId)
    if (!conn) return { status: 'ignored', reason: 'unknown_session' }
    const companyId = conn.companyId

    const exists = await this.findByWaId(companyId, m.id)
    if (exists) return { status: 'duplicate', chatId: exists.chatId, messageId: exists.id }

    const identity = identityOf(m.from, m.alt_jid)
    if (!identity.phone && !identity.lid) return { status: 'ignored', reason: 'no_identity' }
    const upserted = await this.upsertContact(companyId, identity, m)
    if (!upserted) return { status: 'ignored', reason: 'invalid_identity' }
    const { contact, created: contactCreated } = upserted

    const fromContact = !m.from_me
    const live = fromContact && !historical
    const type = crmMessageType(m.type)
    const at = new Date(m.timestamp)
    // Link rastreável: o código sai do texto gravado (e do que fluxos/agentes leem) e o clique é ligado ao contato.
    let body = m.text ?? null
    let adSource: 'ctwa' | 'link' | null = null
    if (live && body) {
      const tracked = await new TrackedLinksService({ db: this.db, now: this.now }).matchInbound(companyId, contact.id, body)
      if (tracked) {
        body = tracked.cleaned
        if (tracked.firstMatch) adSource = 'link'
      }
    }
    if (live && m.ad && (m.ad.ctwa_clid || m.ad.source_id)) {
      await new AttributionService(this.db).recordTouch(companyId, contact.id, { ctwa_clid: m.ad.ctwa_clid ?? null, source_id: m.ad.source_id ?? null, source_url: m.ad.source_url ?? null }, { at: Number.isFinite(at.getTime()) ? at : this.now() })
      // Metadados do anúncio na própria mensagem: evidência mais forte ("origem indicada pelo anúncio").
      await recordAttributionEvidence(this.db, companyId, contact.id, { confidence: 'confirmed_native', method: 'ctwa_referral', sourceId: m.ad.source_id ?? null, at: Number.isFinite(at.getTime()) ? at : this.now() })
      if (m.ad.ctwa_clid) adSource = 'ctwa'
    }
    const r = await this.db.transaction(async (tx) => {
      let chatCreated = false
      let [chat] = await tx
        .select()
        .from(chats)
        .where(and(eq(chats.companyId, companyId), eq(chats.connectionId, conn.connectionId), eq(chats.contactId, contact.id)))
        .for('update')
      if (!chat) {
        const [inserted] = await tx
          .insert(chats)
          .values({ companyId, connectionId: conn.connectionId, contactId: contact.id, status: 'waiting', openedAt: this.now() })
          .onConflictDoNothing()
          .returning()
        if (inserted) {
          chat = inserted
          chatCreated = true
          await tx.insert(chatEvents).values({ companyId, chatId: chat.id, type: 'created', detail: { origin: 'whatsapp' } })
        } else {
          ;[chat] = await tx
            .select()
            .from(chats)
            .where(and(eq(chats.companyId, companyId), eq(chats.connectionId, conn.connectionId), eq(chats.contactId, contact.id)))
            .for('update')
        }
      }
      const [message] = await tx
        .insert(messages)
        .values({
          companyId,
          chatId: chat!.id,
          direction: fromContact ? 'inbound' : 'outbound',
          senderType: fromContact ? 'contact' : 'user',
          type,
          waType: m.type,
          body,
          media: (m.media as Record<string, unknown> | undefined) ?? null,
          quotedWaMessageId: m.quoted_id ?? null,
          // Enviada pelo celular/outro aparelho: já saiu do WhatsApp.
          status: fromContact ? 'received' : 'sent',
          waMessageId: m.id,
          waKey: { remoteJid: m.from, fromMe: m.from_me, id: m.id, ...(m.participant ? { participant: m.participant } : {}) },
          historical,
          waTimestamp: Number.isFinite(at.getTime()) ? at : null,
          ...(fromContact ? {} : { sentAt: at }),
        })
        .onConflictDoNothing({ target: [messages.companyId, messages.waMessageId], where: sql`${messages.waMessageId} is not null` })
        .returning()
      if (!message) return { duplicate: true as const, chatId: chat!.id }

      // Histórica: gravada sem mexer em status, não lidas nem disparar automações.
      let reopened = false
      if (!historical) {
        const set: Partial<typeof chats.$inferInsert> = { updatedAt: this.now() }
        const newer = !chat!.lastMessageAt || at >= chat!.lastMessageAt
        if (newer) Object.assign(set, { lastMessageAt: at, lastMessagePreview: previewOf(type, body) })
        if (live) {
          set.unreadCount = sql`${chats.unreadCount} + 1` as unknown as number
          set.lastInboundAt = at
          if (chat!.status === 'resolved') {
            Object.assign(set, { status: 'waiting', resolvedAt: null, openedAt: this.now(), assignedUserId: null })
            reopened = true
            await tx.insert(chatEvents).values({ companyId, chatId: chat!.id, type: 'reopened', detail: { reason: 'inbound_message', message_id: message.id } })
          }
        }
        ;[chat] = await tx.update(chats).set(set).where(eq(chats.id, chat!.id)).returning()
      } else if (chatCreated) {
        ;[chat] = await tx.update(chats).set({ lastMessageAt: at, lastMessagePreview: previewOf(type, m.text) }).where(eq(chats.id, chat!.id)).returning()
      }
      return { duplicate: false as const, chat: chat!, message, chatCreated, reopened }
    })

    if (r.duplicate) {
      const dup = await this.findByWaId(companyId, m.id)
      return { status: 'duplicate', chatId: r.chatId, messageId: dup?.id ?? '' }
    }

    // Link rastreável sem código (opcional): 1º contato novo da conexão logo depois de um clique → ligação "provável".
    if (live && r.chatCreated && !adSource) {
      const probable = await new TrackedLinksService({ db: this.db, now: this.now }).matchProbable(companyId, conn.connectionId, contact.id, this.now())
      if (probable) adSource = 'link'
    }

    await this.publishMessage(companyId, r.chat, r.message, r.chatCreated, !historical)
    if (contactCreated) await this.publishContact(companyId, contact)

    if (live) {
      const optedOut = await this.applyOptOutKeyword(companyId, contact, r.message)
      if (!optedOut && this.opts.onInbound) {
        await this.opts.onInbound({
          company_id: companyId,
          connection_id: conn.connectionId,
          session_id: sessionId,
          chat_id: r.chat.id,
          contact_id: contact.id,
          message_id: r.message.id,
          wa_message_id: m.id,
          type,
          text: body,
          from_me: false,
          chat_created: r.chatCreated,
          chat_reopened: r.reopened,
          ...(adSource ? { ad_source: adSource } : {}),
        })
      }
    }
    return { status: 'stored', chatId: r.chat.id, messageId: r.message.id, chatCreated: r.chatCreated, contactCreated }
  }

  private async upsertContact(
    companyId: string,
    identity: { phone: string | null; lid: string | null },
    m: IncomingMessage,
  ): Promise<{ contact: ContactDto; created: boolean } | null> {
    const input = {
      phone: identity.phone,
      lid: identity.lid,
      // Mensagem enviada pela própria conta: o push_name é o da conta, não o do contato.
      pushName: m.from_me ? null : (m.push_name ?? null),
      ad: m.ad ? { ctwaClid: m.ad.ctwa_clid ?? null, sourceId: m.ad.source_id ?? null, sourceUrl: m.ad.source_url ?? null, mediaUrl: m.ad.media_url ?? null } : null,
    }
    try {
      return await this.contacts.upsertFromWhatsApp(companyId, input)
    } catch (err) {
      if (!(err instanceof ContactsError) || err.code !== 'validation') throw err
      // Telefone que não valida (numeração nova/estranha): segue só com o LID, se houver.
      if (identity.phone && identity.lid) return this.contacts.upsertFromWhatsApp(companyId, { ...input, phone: null })
      this.log.warn({ company_id: companyId, wa_message_id: m.id }, 'mensagem ignorada: identidade do contato inválida')
      return null
    }
  }

  /** AC-T33-07: palavra de opt-out → opt_out = true, `WaGateway.optOut` e auditoria. Reverter só manualmente. */
  private async applyOptOutKeyword(companyId: string, contact: ContactDto, message: MessageRow): Promise<boolean> {
    if (contact.opt_out || !message.body) return false
    const [company] = await this.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId))
    const keyword = matchOptOutKeyword(message.body, optOutKeywordsFrom(company?.settings))
    if (!keyword) return false
    const updated = await this.contacts.update(companyId, contact.id, { optOut: true })
    await this.db.insert(auditLogs).values({
      companyId,
      actorUserId: null,
      action: 'contacts.opt_out',
      targetType: 'contact',
      targetId: contact.id,
      detail: { source: 'inbound_keyword', keyword, message_id: message.id, wa_message_id: message.waMessageId },
    })
    await this.publishContact(companyId, updated)
    return true
  }

  // ---- message.status -------------------------------------------------------------------------------------

  private async applyStatus(event: WaEventOf<'message.status'>): Promise<IngestOutcome> {
    const conn = await this.resolve(event.session_id)
    if (!conn) return { status: 'ignored', reason: 'unknown_session' }
    const next = event.status as CrmMessageStatus
    const row = await this.db.transaction(async (tx) => {
      let [msg] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.companyId, conn.companyId), eq(messages.pipelineMessageId, event.message_id)))
        .for('update')
      if (!msg && event.transport_message_id) {
        ;[msg] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.companyId, conn.companyId), eq(messages.waMessageId, event.transport_message_id)))
          .for('update')
      }
      if (!msg || !canAdvanceStatus(msg.status, next)) return null
      const at = new Date(event.at)
      const set: Partial<typeof messages.$inferInsert> = { status: next, updatedAt: this.now() }
      if (next === 'sent') set.sentAt = msg.sentAt ?? at
      if (next === 'delivered') Object.assign(set, { deliveredAt: msg.deliveredAt ?? at, sentAt: msg.sentAt ?? at })
      if (next === 'read') Object.assign(set, { readAt: msg.readAt ?? at, deliveredAt: msg.deliveredAt ?? at, sentAt: msg.sentAt ?? at })
      if (next === 'failed' || next === 'cancelled') set.error = event.error ?? null
      if (!msg.waMessageId && event.transport_message_id) set.waMessageId = event.transport_message_id
      const [updated] = await tx.update(messages).set(set).where(eq(messages.id, msg.id)).returning()
      return updated!
    })
    if (!row) return { status: 'ignored', reason: 'not_found_or_stale' }
    const [chat] = await this.db.select().from(chats).where(eq(chats.id, row.chatId))
    await this.publish(conn.companyId, 'message.status', { chat_id: row.chatId, message_id: row.id, status: row.status, error: row.error }, chat)
    return { status: 'updated' }
  }

  // ---- contatos ---------------------------------------------------------------------------------------------

  /** `contact.upsert` (agenda/sincronização): só completa contatos que já existem; não cria contato novo. */
  private async contactUpsert(event: WaEventOf<'contact.upsert'>): Promise<IngestOutcome> {
    const conn = await this.resolve(event.session_id)
    if (!conn) return { status: 'ignored', reason: 'unknown_session' }
    const c = event.contact
    if (isIgnoredJid(c.jid)) return { status: 'ignored', reason: 'group_or_broadcast' }
    const identity = identityOf(c.jid, c.lid ?? null)
    const phone = c.phone ?? identity.phone
    const lid = identity.lid
    if (phone && lid) return this.mergeAndPublish(conn, lid, phone)
    const existing = await this.contacts.findDuplicates(conn.companyId, { ...(phone ? { phone } : {}) })
    const target = lid ? (await this.findContactByLid(conn.companyId, lid)) : existing[0]
    const name = c.name ?? c.push_name ?? null
    if (!target || target.name || !name) return { status: 'ignored', reason: 'nothing_to_update' }
    const updated = await this.contacts.update(conn.companyId, target.id, { name })
    await this.publishContact(conn.companyId, updated)
    return { status: 'updated' }
  }

  /** `contact.lid_mapping`: funde o contato LID no do telefone (e os chats, sem duplicar). Idempotente. */
  private async lidMapping(event: WaEventOf<'contact.lid_mapping'>): Promise<IngestOutcome> {
    const conn = await this.resolve(event.session_id)
    if (!conn) return { status: 'ignored', reason: 'unknown_session' }
    const pn = identityOf(event.pn).phone ?? event.pn
    return this.mergeAndPublish(conn, event.lid, pn)
  }

  private async mergeAndPublish(conn: ResolvedConnection, lid: string, phone: string): Promise<IngestOutcome> {
    let merged: ContactDto | null
    try {
      merged = await this.contacts.mergeIdentity(conn.companyId, lid, phone)
    } catch (err) {
      if (err instanceof ContactsError && err.code === 'validation') return { status: 'ignored', reason: 'invalid_identity' }
      throw err
    }
    if (!merged) return { status: 'ignored', reason: 'no_contact' }
    await this.publishContact(conn.companyId, merged)
    const rows = await this.db.select().from(chats).where(and(eq(chats.companyId, conn.companyId), eq(chats.contactId, merged.id))).orderBy(asc(chats.createdAt))
    for (const chat of rows) await this.publish(conn.companyId, 'chat.updated', { chat_id: chat.id, chat: toChatDto(chat) as never }, chat)
    return { status: 'updated' }
  }

  // ---- internos ---------------------------------------------------------------------------------------------

  private async findByWaId(companyId: string, waMessageId: string): Promise<{ id: string; chatId: string } | undefined> {
    const [row] = await this.db
      .select({ id: messages.id, chatId: messages.chatId })
      .from(messages)
      .where(and(eq(messages.companyId, companyId), eq(messages.waMessageId, waMessageId)))
    return row
  }

  private async findContactByLid(companyId: string, lid: string): Promise<ContactDto | undefined> {
    const res = await this.db.execute(sql`select id from crm.contacts where company_id = ${companyId} and wa_lid = ${lid} limit 1`)
    const id = (res.rows[0] as { id?: string } | undefined)?.id
    return id ? this.contacts.get(companyId, id) : undefined
  }

  private async publishMessage(companyId: string, chat: ChatRow, message: MessageRow, chatCreated: boolean, chatChanged: boolean): Promise<void> {
    const chatDto = toChatDto(chat) as never
    if (chatCreated) await this.publish(companyId, 'chat.created', { chat_id: chat.id, chat: chatDto }, chat)
    await this.publish(companyId, 'message.created', { chat_id: chat.id, message: toMessageDto(message) as never }, chat)
    if (!chatCreated && chatChanged) await this.publish(companyId, 'chat.updated', { chat_id: chat.id, chat: chatDto }, chat)
  }

  private async publishContact(companyId: string, contact: ContactDto): Promise<void> {
    await this.publish(companyId, 'contact.updated', { contact_id: contact.id, contact: contact as never })
  }

  /** Publica sem derrubar a ingestão: o dado já está no banco; o cliente recupera no próximo carregamento. */
  private async publish<T extends RealtimeEventType>(companyId: string, type: T, data: RealtimeEventData<T>, chat?: ChatRow): Promise<void> {
    if (!this.opts.publisher) return
    try {
      await this.opts.publisher.publish(companyId, type, data, chat ? { scope: chatScope(chat) } : {})
    } catch (err) {
      this.log.error({ err, company_id: companyId, type }, 'falha ao publicar evento realtime')
    }
  }
}
