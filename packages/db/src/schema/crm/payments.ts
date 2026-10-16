import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { contacts } from './contacts.js'
import { flowNodes, flowRuns } from './flows.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Pagamentos ao lead (T109; 19-integracoes.md §3.1, §4.6). Não confundir com a cobrança do SaaS (`BillingProvider`).
// Segredos só cifrados (SPEC 1.4 nº 8): `*_enc` = `serializeEncrypted` com AAD `payment-integration/<company>/<id>/<campo>`.
// Dinheiro em centavos (`*_cents bigint`) + `currency` ISO (SPEC 3.6).

export const PAYMENT_GATEWAY_IDS = ['xpag', 'zenith'] as const
export type PaymentGatewayId = (typeof PAYMENT_GATEWAY_IDS)[number]

export const PAYMENT_CHARGE_STATUSES = ['created', 'approved', 'failed', 'expired', 'refunded'] as const
export type PaymentChargeStatus = (typeof PAYMENT_CHARGE_STATUSES)[number]

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })
const cents = (name: string) => bigint(name, { mode: 'number' })

export const paymentIntegrations = crm.table(
  'payment_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    label: text('label').notNull(),
    /** Fixo depois de criado. */
    gateway: text('gateway').$type<PaymentGatewayId>().notNull(),
    clientId: text('client_id').notNull().default(''),
    /** Nulo só em integrações sem segredo manual (ex.: Zenith por OAuth, T110). */
    clientSecretEnc: text('client_secret_enc'),
    /** Últimos 4 caracteres do segredo, para exibir `…abcd`. */
    secretHint: text('secret_hint'),
    /** Gerado pelo CRM ao criar; autentica o webhook recebido do gateway. Nunca sai pela API. */
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    /** Criada por OAuth (Zenith, T110): sem campos de chave na edição. */
    zenithOauth: boolean('zenith_oauth').notNull().default(false),
    /** Credenciais extras do adapter (tokens OAuth etc.), cifradas como JSON. */
    extraEnc: text('extra_enc'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('payment_integrations_company_gateway_idx').on(t.companyId, t.gateway, t.createdAt),
    check('payment_integrations_label_len', sql`char_length(${t.label}) between 2 and 120`),
    check('payment_integrations_gateway_check', sql`${t.gateway} in ('xpag', 'zenith')`),
  ],
)

export const paymentCharges = crm.table(
  'payment_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    integrationId: uuid('integration_id').references(() => paymentIntegrations.id, { onDelete: 'set null' }),
    gateway: text('gateway').$type<PaymentGatewayId>().notNull(),
    flowRunId: uuid('flow_run_id').references(() => flowRuns.id, { onDelete: 'set null' }),
    nodeId: uuid('node_id').references(() => flowNodes.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Nulo = "chave sem valor" (o lead paga o que quiser). */
    amountCents: cents('amount_cents'),
    currency: text('currency').notNull(),
    method: text('method').notNull(),
    transactionId: text('transaction_id').notNull(),
    status: text('status').$type<PaymentChargeStatus>().notNull().default('created'),
    paidAmountCents: cents('paid_amount_cents'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Até quando a confirmação ainda interrompe o contato (`listener_ttl` do bloco). */
    listenerUntil: timestamp('listener_until', { withTimezone: true }),
    /** Instruções devolvidas pelo gateway (código, QR, banco), sem segredos. */
    instructions: jsonb('instructions').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_charges_gateway_tx_uq').on(t.gateway, t.transactionId),
    index('payment_charges_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('payment_charges_run_idx').on(t.flowRunId),
    check('payment_charges_status_check', sql`${t.status} in ('created', 'approved', 'failed', 'expired', 'refunded')`),
    check('payment_charges_amount_ck', sql`${t.amountCents} is null or ${t.amountCents} > 0`),
  ],
)
