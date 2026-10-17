import { index, integer, text, timestamp, uniqueIndex, uuid, boolean } from 'drizzle-orm/pg-core'
import { users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Operações do admin da plataforma (T96; 20-admin-interno.md §3.6, §3.7, §3.9): avisos e banners globais (o cliente
// recebe só ativos e não expirados, por prioridade decrescente) e segredos de plataforma (chaves de IA, cifrados).

export const ANNOUNCEMENT_TYPES = ['info', 'warning', 'error', 'success'] as const
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number]
export const announcementTypeEnum = crm.enum('announcement_type', ANNOUNCEMENT_TYPES)

export const announcements = crm.table(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    imageUrl: text('image_url'),
    url: text('url'),
    announcementType: announcementTypeEnum('announcement_type').notNull().default('info'),
    priority: integer('priority').notNull().default(0),
    /** Nulo = não expira. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('announcements_active_priority_idx').on(t.active, t.priority)],
)

/** Banner do dashboard: `title` é o nome interno; imagem por URL (o `/api/media` é por empresa). */
export const banners = crm.table(
  'banners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title'),
    imageUrl: text('image_url').notNull(),
    url: text('url'),
    priority: integer('priority').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('banners_active_priority_idx').on(t.active, t.priority)],
)

/**
 * Segredo de plataforma (só escrita pela API): `key` = provedor (`anthropic`, `elevenlabs`, `groq`…). `value_enc` é
 * `serializeEncrypted` com AAD `platform-secret/<key>`; `hint` guarda os 4 últimos caracteres para a máscara.
 */
export const platformSecrets = crm.table(
  'platform_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    valueEnc: text('value_enc').notNull(),
    hint: text('hint').notNull(),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('platform_secrets_key_uq').on(t.key)],
)
