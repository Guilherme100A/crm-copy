import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Pixel / Conversions API da Meta (T104; 11 §3.3, §5.4; STACK E §1.7): configurações de pixel (token CAPI só cifrado,
// SPEC 1.4 nº 8) e o registro dos eventos enviados — dedupe por (pixel, event_id), já que a deduplicação de eventos
// de servidor fica por nossa conta.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const PIXEL_PLATFORMS = ['facebook'] as const
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number]

export const pixelConfigs = crm.table(
  'pixel_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    platform: text('platform').$type<PixelPlatform>().notNull().default('facebook'),
    /** Id numérico do pixel/dataset. */
    pixelId: text('pixel_id').notNull(),
    /** `serializeEncrypted` (AES-256-GCM, AAD `pixel_config/<id>/token`). Nunca sai pela API sem pedido explícito. */
    accessTokenEnc: text('access_token_enc').notNull(),
    /** Envia `Purchase` automaticamente a cada venda registrada (`sale.recorded`). */
    autoSendSales: boolean('auto_send_sales').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('pixel_configs_company_idx').on(t.companyId, t.createdAt),
    check('pixel_configs_pixel_id_ck', sql`${t.pixelId} ~ '^[0-9]+$'`),
    check('pixel_configs_name_ck', sql`char_length(${t.name}) between 2 and 255`),
  ],
)

export const CAPI_EVENT_STATUSES = ['pending', 'sent', 'failed'] as const
export type CapiEventStatus = (typeof CAPI_EVENT_STATUSES)[number]

/** Um evento por (pixel, event_id): o mesmo `event_id` de novo não gera outro POST (AC-T104-02). */
export const capiEventLog = crm.table(
  'capi_event_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    pixelConfigId: uuid('pixel_config_id')
      .notNull()
      .references(() => pixelConfigs.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventName: text('event_name').notNull(),
    actionSource: text('action_source').notNull(),
    status: text('status').$type<CapiEventStatus>().notNull().default('pending'),
    /** Quem originou: `flow` (nó pixel), `sale` (venda registrada) ou `manual`. */
    source: text('source').notNull(),
    sourceId: text('source_id'),
    /** Resposta da Meta (`events_received`, `fbtrace_id`) ou o erro. Sem dados pessoais. */
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('capi_event_log_pixel_event_uq').on(t.pixelConfigId, t.eventId), index('capi_event_log_company_idx').on(t.companyId, t.createdAt)],
)
