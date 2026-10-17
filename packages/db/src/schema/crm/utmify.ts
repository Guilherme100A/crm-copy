import { sql } from 'drizzle-orm'
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { sales } from './sales.js'
import { createdAt, crm, updatedAt } from './schema.js'

// UTMify: integrações por empresa e envio das vendas (T113; 11-facebook-ads.md §3.6, 19-integracoes.md §3.4, §3.9).
// Token só cifrado (SPEC 1.4 nº 8): `token_enc` = `serializeEncrypted` com AAD `utmify-integration/<company>/<id>/token`.

/** Status da venda que geram um envio à UTMify (aprovada → `paid`, reembolsada → `refunded`). */
export const UTMIFY_SALE_STATUSES = ['approved', 'refunded'] as const
export type UtmifySaleStatus = (typeof UTMIFY_SALE_STATUSES)[number]

/** Estado de um envio. Sem linha em `sale_utmify_events` = "Não enviado". */
export const UTMIFY_SEND_STATUSES = ['pending', 'succeeded', 'failed'] as const
export type UtmifySendStatus = (typeof UTMIFY_SEND_STATUSES)[number]

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const utmifyIntegrations = crm.table(
  'utmify_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    companyName: text('company_name').notNull(),
    /** Nulo = sem token (`token_configured: false`; o envio falha com "Integração UTMify não configurada"). */
    tokenEnc: text('token_enc'),
    /** Últimos 4 caracteres do token, para exibir `…abcd`. */
    tokenHint: text('token_hint'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('utmify_integrations_company_idx').on(t.companyId, t.createdAt),
    check('utmify_integrations_company_name_len', sql`char_length(${t.companyName}) between 2 and 120`),
  ],
)

/** Um envio por (venda, status da venda): idempotência do AC-T113-02. */
export const saleUtmifyEvents = crm.table(
  'sale_utmify_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    /** Status da venda enviado (`approved` | `refunded`). */
    saleStatus: text('sale_status').$type<UtmifySaleStatus>().notNull(),
    /** Integração usada (nula se foi excluída depois). */
    utmifyIntegrationId: uuid('utmify_integration_id').references(() => utmifyIntegrations.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<UtmifySendStatus>().notNull().default('pending'),
    /** Chamadas à UTMify neste envio (máximo 3). */
    attempts: integer('attempts').notNull().default(0),
    /** Último erro, sem credenciais. */
    lastError: text('last_error'),
    /** Quando a mudança de status foi detectada (vira `refundedAt` no envio do reembolso). */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sale_utmify_events_sale_status_uq').on(t.saleId, t.saleStatus),
    index('sale_utmify_events_company_status_idx').on(t.companyId, t.status),
    check('sale_utmify_events_sale_status_check', sql`${t.saleStatus} in ('approved', 'refunded')`),
    check('sale_utmify_events_status_check', sql`${t.status} in ('pending', 'succeeded', 'failed')`),
  ],
)
