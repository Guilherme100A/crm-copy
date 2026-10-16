import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { aiAgents } from './ai-agents.js'
import { connections } from './connections.js'
import { contacts, labels } from './contacts.js'
import { departments } from './departments.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Chats e mensagens do CRM (T33; feature 03). Um chat por (empresa, conexão, contato).
// `connection_id` aponta para crm.connections (T40), `department_id` para departamentos (T31) e `ai_agent_id` para
// agentes (T39); as FKs entram nessas tarefas, por isso aqui são uuid soltos.

export const CHAT_STATUSES = ['waiting', 'attending', 'resolved'] as const
export type ChatStatus = (typeof CHAT_STATUSES)[number]

export const MESSAGE_DIRECTIONS_CRM = ['inbound', 'outbound'] as const
export type CrmMessageDirection = (typeof MESSAGE_DIRECTIONS_CRM)[number]

/** Remetente da mensagem. `flow` = enviada por um nó de fluxo (T120/T121); `system` = automação do CRM (ex.: fora do horário). */
export const MESSAGE_SENDER_TYPES = ['contact', 'user', 'bot', 'ai', 'system', 'flow'] as const
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number]

/** Estados de entrega (os do pipeline, SPEC 3.8) + `received` para mensagens que chegaram. */
export const CRM_MESSAGE_STATUSES = ['received', 'queued', 'processing', 'retrying', 'sent', 'delivered', 'read', 'failed', 'cancelled'] as const
export type CrmMessageStatus = (typeof CRM_MESSAGE_STATUSES)[number]

export const chats = crm.table(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // FK da T40: não se apaga conexão com chats (a exclusão definitiva decide o destino deles).
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: text('status').$type<ChatStatus>().notNull().default('waiting'),
    assignedUserId: uuid('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    // FK da T31: departamento excluído deixa o chat sem departamento.
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    // FK da T39: agente excluído deixa o chat sem agente.
    aiAgentId: uuid('ai_agent_id').references(() => aiAgents.id, { onDelete: 'set null' }),
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessagePreview: text('last_message_preview'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    firstHumanReplyAt: timestamp('first_human_reply_at', { withTimezone: true }),
    firstHumanReplyBy: uuid('first_human_reply_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    blocked: boolean('blocked').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('chats_company_connection_contact_uq').on(t.companyId, t.connectionId, t.contactId),
    index('chats_company_status_last_idx').on(t.companyId, t.status, t.lastMessageAt),
    index('chats_company_contact_idx').on(t.companyId, t.contactId),
  ],
)

export const messages = crm.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<CrmMessageDirection>().notNull(),
    senderType: text('sender_type').$type<MessageSenderType>().notNull(),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Tipo do conteúdo (`text`, `image`, `audio`…; o original do WhatsApp fica em `wa_type`). */
    type: text('type').notNull(),
    waType: text('wa_type'),
    body: text('body'),
    /** MediaHandle do wa-engine (session_id, message_id, mime, size, sha256, key, status). */
    media: jsonb('media').$type<Record<string, unknown>>(),
    quotedWaMessageId: text('quoted_wa_message_id'),
    status: text('status').$type<CrmMessageStatus>().notNull(),
    error: text('error'),
    /** Id da mensagem no WhatsApp. */
    waMessageId: text('wa_message_id'),
    /** Id da mensagem no pipeline de envio (MessageView.id do WaGateway). */
    pipelineMessageId: text('pipeline_message_id'),
    /** Key do Baileys (remoteJid, fromMe, id, participant) para reagir, citar, apagar e marcar como lida. */
    waKey: jsonb('wa_key').$type<Record<string, unknown>>(),
    historical: boolean('historical').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Momento da mensagem no WhatsApp. */
    waTimestamp: timestamp('wa_timestamp', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('messages_company_wa_id_uq').on(t.companyId, t.waMessageId).where(sql`${t.waMessageId} is not null`),
    uniqueIndex('messages_company_pipeline_id_uq').on(t.companyId, t.pipelineMessageId).where(sql`${t.pipelineMessageId} is not null`),
    index('messages_chat_created_idx').on(t.chatId, t.createdAt),
  ],
)

export const messageReactions = crm.table(
  'message_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** `contact` ou o usuário que reagiu. */
    actorType: text('actor_type').$type<'contact' | 'user'>().notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('message_reactions_message_idx').on(t.messageId)],
)

export const chatNotes = crm.table(
  'chat_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('chat_notes_chat_idx').on(t.chatId, t.createdAt)],
)

export const chatLabels = crm.table(
  'chat_labels',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: 'chat_labels_pk', columns: [t.chatId, t.labelId] }), index('chat_labels_company_label_idx').on(t.companyId, t.labelId)],
)

/** Linha do tempo do chat (criado, reaberto, atribuído, resolvido…). */
export const chatEvents = crm.table(
  'chat_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('chat_events_chat_idx').on(t.chatId, t.createdAt)],
)
