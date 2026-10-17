import { sql } from 'drizzle-orm'
import { check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { sales } from './sales.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Emissão de NF na venda aprovada (T112; 19-integracoes.md §3.2, §4.2, §5.4). Único provedor: Notasy.
// Token só cifrado (SPEC 1.4 nº 8): `token_enc` = `serializeEncrypted` com AAD `invoice-integration/<company>/<id>/token`.

export const INVOICE_PROVIDERS = ['notasy'] as const
export type InvoiceProvider = (typeof INVOICE_PROVIDERS)[number]

/** `invoice_emit_status` (19 §4.2). Sem linha em `sale_invoices` = "Sem emissor". */
export const INVOICE_EMIT_STATUSES = ['pending', 'succeeded', 'failed'] as const
export type InvoiceEmitStatus = (typeof INVOICE_EMIT_STATUSES)[number]

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const invoiceIntegrations = crm.table(
  'invoice_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    /** Fixo depois de criado. */
    provider: text('provider').$type<InvoiceProvider>().notNull().default('notasy'),
    companyName: text('company_name').notNull(),
    /** Nulo = emissor sem token configurado (a emissão falha com "Emissor não configurado"). */
    tokenEnc: text('token_enc'),
    /** Últimos 4 caracteres do token, para exibir `…abcd`. */
    tokenHint: text('token_hint'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('invoice_integrations_company_idx').on(t.companyId, t.createdAt),
    check('invoice_integrations_company_name_len', sql`char_length(${t.companyName}) between 2 and 120`),
    check('invoice_integrations_provider_check', sql`${t.provider} in ('notasy')`),
  ],
)

/** Estado da emissão de NF de uma venda (uma linha por venda; a reemissão reaproveita a linha). */
export const saleInvoices = crm.table(
  'sale_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    /** Emissor usado na última tentativa (nulo se foi excluído depois). */
    invoiceIntegrationId: uuid('invoice_integration_id').references(() => invoiceIntegrations.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<InvoiceEmitStatus>().notNull().default('pending'),
    /** Tentativas no emissor nesta emissão (zera ao reemitir; máximo 3). */
    attempts: integer('attempts').notNull().default(0),
    /** Emissão atual: 1 na automática, +1 a cada reemissão (compõe o jobId `invoice-<saleId>-<n>`). */
    generation: integer('generation').notNull().default(1),
    /** `invoice_last_error` (19 §4.2), sem credenciais. */
    lastError: text('last_error'),
    /** Id da venda/nota no emissor, quando ele informa. */
    externalId: text('external_id'),
    number: text('number'),
    pdfUrl: text('pdf_url'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sale_invoices_sale_uq').on(t.saleId),
    index('sale_invoices_company_status_idx').on(t.companyId, t.status),
    check('sale_invoices_status_check', sql`${t.status} in ('pending', 'succeeded', 'failed')`),
  ],
)
