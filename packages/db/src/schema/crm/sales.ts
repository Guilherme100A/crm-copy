import { sql } from 'drizzle-orm'
import { bigint, check, date, index, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { contacts } from './contacts.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Vendas, produtos, regras de despesa e grupos de filtro do dashboard (T34; 02 §3.5–3.7, 19 §3.5).
// Dinheiro em centavos (`*_cents bigint`) + `currency char(3)` (SPEC 3.6). `connection_id` é uuid solto até a T40.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })
const cents = (name: string) => bigint(name, { mode: 'number' })

export const products = crm.table(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    /** Id exibido e referenciado pelo bloco "Venda aprovada" (`product_public_id`). */
    publicId: uuid('public_id').notNull().defaultRandom(),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('BRL'),
    priceMinCents: cents('price_min_cents').notNull(),
    priceMaxCents: cents('price_max_cents').notNull(),
    priceFallbackCents: cents('price_fallback_cents').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_public_id_uq').on(t.publicId),
    index('products_company_name_idx').on(t.companyId, t.name),
    check('products_prices_ck', sql`${t.priceMinCents} >= 0 and ${t.priceMaxCents} >= ${t.priceMinCents} and ${t.priceFallbackCents} > 0`),
  ],
)

export const SALE_SOURCES = ['manual', 'flow', 'webhook'] as const
export type SaleSource = (typeof SALE_SOURCES)[number]
export const SALE_STATUSES = ['approved', 'refunded', 'chargeback', 'pending'] as const
export type SaleStatus = (typeof SALE_STATUSES)[number]

export const sales = crm.table(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id'),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    amountCents: cents('amount_cents').notNull(),
    currency: text('currency').notNull().default('BRL'),
    soldAt: timestamp('sold_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').$type<SaleSource>().notNull().default('manual'),
    /** Id do anúncio Meta (cruzamento venda ↔ anúncio); herdado do contato se ausente. */
    sourceId: text('source_id'),
    ctwaClid: text('ctwa_clid'),
    /** Id da venda na origem (webhook, gateway); idempotência por (empresa, origem, external_id). */
    externalId: text('external_id'),
    status: text('status').$type<SaleStatus>().notNull().default('approved'),
    instanceName: text('instance_name'),
    instanceNumber: text('instance_number'),
    leadNumber: text('lead_number'),
    customerName: text('customer_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sales_company_source_external_uq').on(t.companyId, t.source, t.externalId).where(sql`${t.externalId} is not null`),
    index('sales_company_sold_idx').on(t.companyId, t.soldAt),
    index('sales_company_product_idx').on(t.companyId, t.productId),
    check('sales_source_ck', sql`${t.source} in ('manual', 'flow', 'webhook')`),
    check('sales_status_ck', sql`${t.status} in ('approved', 'refunded', 'chargeback', 'pending')`),
    check('sales_amount_ck', sql`${t.amountCents} >= 0`),
  ],
)

export const EXPENSE_KINDS = ['fixed', 'percent'] as const
export const EXPENSE_PERCENT_BASES = ['revenue', 'spend', 'profit_pre'] as const
export const EXPENSE_PERIODS = ['day', 'week', 'month'] as const

/** Regra de despesa (02 §3.5): fixa (centavos) ou percentual sobre uma base, por período, com vigência. */
export const expenseRules = crm.table(
  'expense_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    kind: text('kind').$type<(typeof EXPENSE_KINDS)[number]>().notNull().default('fixed'),
    amountCents: cents('amount_cents'),
    currency: text('currency'),
    percent: numeric('percent', { precision: 7, scale: 4 }),
    percentBase: text('percent_base').$type<(typeof EXPENSE_PERCENT_BASES)[number]>(),
    period: text('period').$type<(typeof EXPENSE_PERIODS)[number]>().notNull().default('month'),
    activeFrom: date('active_from'),
    activeTo: date('active_to'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('expense_rules_company_idx').on(t.companyId, t.name),
    check(
      'expense_rules_kind_ck',
      sql`(${t.kind} = 'fixed' and ${t.amountCents} is not null) or (${t.kind} = 'percent' and ${t.percent} is not null and ${t.percentBase} is not null)`,
    ),
  ],
)

/** Grupo de filtros salvo do dashboard (02 §3.6): nome único por empresa sem diferenciar caixa. */
export const dashboardFilterGroups = crm.table(
  'dashboard_filter_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    connectionIds: uuid('connection_ids').array().notNull().default(sql`'{}'::uuid[]`),
    productIds: uuid('product_ids').array().notNull().default(sql`'{}'::uuid[]`),
    adAccountIds: text('ad_account_ids').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('dashboard_filter_groups_company_name_uq').on(t.companyId, sql`lower(trim(${t.name}))`)],
)
