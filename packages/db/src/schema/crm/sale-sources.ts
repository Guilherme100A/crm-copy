import { sql } from 'drizzle-orm'
import { bigserial, boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { contacts } from './contacts.js'
import { sales } from './sales.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Fontes de venda por webhook genérico e atribuição (T73; 19 §5.5, 11 §3.7): cada fonte tem um token público
// (`POST /api/hooks/sales/:token`), um segredo HMAC opcional (cifrado), o mapeamento JSONPath → SaleEvent e a tabela
// de status. Cada POST aceito vira um `inbound_sale_events` (bruto + status + erro + venda) processado na fila
// `inbound-sales`. `contact_attribution` guarda o primeiro e o último toque (UTM/CTWA) de cada contato.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const SALE_SOURCE_AMOUNT_UNITS = ['decimal', 'cents'] as const
export type SaleSourceAmountUnit = (typeof SALE_SOURCE_AMOUNT_UNITS)[number]

export const saleSources = crm.table(
  'sale_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    /** Token da URL pública (≥ 43 chars, base64url). Rotacionável. */
    token: text('token').notNull(),
    /** `serializeEncrypted` (AAD `sale-source/<company>/<id>/hmac`); nulo = sem HMAC. Nunca sai pela API. */
    hmacSecretEnc: text('hmac_secret_enc'),
    /** `{ campo do SaleEvent: JSONPath }`. */
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
    /** `{ status bruto (minúsculo): approved|refunded|chargeback|pending }`, somado ao mapa padrão. */
    statusMap: jsonb('status_map').$type<Record<string, string>>().notNull().default({}),
    amountUnit: text('amount_unit').$type<SaleSourceAmountUnit>().notNull().default('decimal'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sale_sources_token_uq').on(t.token),
    index('sale_sources_company_idx').on(t.companyId, t.createdAt),
    check('sale_sources_name_len', sql`char_length(${t.name}) between 2 and 120`),
    check('sale_sources_amount_unit_ck', sql`${t.amountUnit} in ('decimal', 'cents')`),
  ],
)

export const INBOUND_SALE_EVENT_STATUSES = ['pending', 'processed', 'failed'] as const
export type InboundSaleEventStatus = (typeof INBOUND_SALE_EVENT_STATUSES)[number]

export const inboundSaleEvents = crm.table(
  'inbound_sale_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Ordem de chegada. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companyId: companyId(),
    saleSourceId: uuid('sale_source_id')
      .notNull()
      .references(() => saleSources.id, { onDelete: 'cascade' }),
    status: text('status').$type<InboundSaleEventStatus>().notNull().default('pending'),
    rawBody: text('raw_body').notNull(),
    /** SaleEvent resolvido (quando o mapeamento resolveu). */
    saleEvent: jsonb('sale_event').$type<Record<string, unknown>>(),
    error: text('error'),
    /** Campos que o mapeamento não resolveu: `[{ field, path }]`. */
    missing: jsonb('missing').$type<{ field: string; path: string }[]>().notNull().default([]),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(0),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('inbound_sale_events_source_seq_idx').on(t.saleSourceId, t.seq),
    index('inbound_sale_events_company_status_idx').on(t.companyId, t.status),
    check('inbound_sale_events_status_ck', sql`${t.status} in ('pending', 'processed', 'failed')`),
  ],
)

/** Primeiro e último toque de atribuição de cada contato (first nunca é sobrescrito). */
export const contactAttribution = crm.table(
  'contact_attribution',
  {
    contactId: uuid('contact_id')
      .primaryKey()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: companyId(),
    firstUtmSource: text('first_utm_source'),
    firstUtmMedium: text('first_utm_medium'),
    firstUtmCampaign: text('first_utm_campaign'),
    firstUtmContent: text('first_utm_content'),
    firstUtmTerm: text('first_utm_term'),
    firstCtwaClid: text('first_ctwa_clid'),
    firstSourceId: text('first_source_id'),
    firstSourceUrl: text('first_source_url'),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
    firstSaleSourceId: uuid('first_sale_source_id').references(() => saleSources.id, { onDelete: 'set null' }),
    lastUtmSource: text('last_utm_source'),
    lastUtmMedium: text('last_utm_medium'),
    lastUtmCampaign: text('last_utm_campaign'),
    lastUtmContent: text('last_utm_content'),
    lastUtmTerm: text('last_utm_term'),
    lastCtwaClid: text('last_ctwa_clid'),
    lastSourceId: text('last_source_id'),
    lastSourceUrl: text('last_source_url'),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
    lastSaleSourceId: uuid('last_sale_source_id').references(() => saleSources.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [index('contact_attribution_company_idx').on(t.companyId)],
)
