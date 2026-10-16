import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Conteúdo reutilizável (T35; 17-configuracoes-conteudo.md §3A–3C, 03 F37/F48–F49): respostas rápidas com ações
// ordenadas, modelos INTERNOS de mensagem (no lugar dos templates WABA), variáveis globais `g_*` e figurinhas.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const QUICK_REPLY_ACTION_TYPES = ['send_message', 'send_multi_media', 'send_sticker', 'send_contact'] as const
export type QuickReplyActionType = (typeof QUICK_REPLY_ACTION_TYPES)[number]

export const quickReplies = crm.table(
  'quick_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    /** Normalizado: minúsculas, `[a-z0-9_ -]` (17 §3A). */
    shortcut: text('shortcut').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('quick_replies_company_shortcut_uq').on(t.companyId, t.shortcut)],
)

export const quickReplyActions = crm.table(
  'quick_reply_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    quickReplyId: uuid('quick_reply_id')
      .notNull()
      .references(() => quickReplies.id, { onDelete: 'cascade' }),
    type: text('type').$type<QuickReplyActionType>().notNull(),
    order: integer('order').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('quick_reply_actions_company_reply_idx').on(t.companyId, t.quickReplyId, t.order),
    check('quick_reply_actions_type_check', sql`${t.type} in ('send_message', 'send_multi_media', 'send_sticker', 'send_contact')`),
  ],
)

export const messageTemplates = crm.table(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    /** `{ type: none|text|image|video|document, text?, media_id? }`. */
    header: jsonb('header').$type<Record<string, unknown>>().notNull().default({ type: 'none' }),
    body: text('body').notNull(),
    footer: text('footer'),
    /** `[{ type: reply|url|phone, text, url?, phone? }]` — enviados como texto (menu numerado e links). */
    buttons: jsonb('buttons').$type<Record<string, unknown>[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('message_templates_company_name_uq').on(t.companyId, sql`lower(${t.name})`)],
)

export const GLOBAL_VARIABLE_TYPES = ['text', 'number'] as const
export type GlobalVariableType = (typeof GLOBAL_VARIABLE_TYPES)[number]

export const globalVariables = crm.table(
  'global_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    /** `g_` + `[A-Za-z0-9_]`; imutável (o fluxo referencia `{g_…}`). */
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').$type<GlobalVariableType>().notNull().default('text'),
    value: text('value'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('global_variables_company_name_uq').on(t.companyId, sql`lower(${t.name})`),
    check('global_variables_name_check', sql`${t.name} ~ '^g_[A-Za-z0-9_]+$'`),
    check('global_variables_type_check', sql`${t.type} in ('text', 'number')`),
  ],
)

export const stickers = crm.table(
  'stickers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    /** Id opaco do MediaService (T49) para a empresa. */
    mediaId: text('media_id').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('stickers_company_idx').on(t.companyId, t.createdAt)],
)

/** Favoritas são por usuário (03 F37, aba Favoritos). */
export const stickerFavorites = crm.table(
  'sticker_favorites',
  {
    companyId: companyId(),
    stickerId: uuid('sticker_id')
      .notNull()
      .references(() => stickers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: 'sticker_favorites_pk', columns: [t.stickerId, t.userId] }), index('sticker_favorites_company_user_idx').on(t.companyId, t.userId)],
)
