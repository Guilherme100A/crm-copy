import { sql } from 'drizzle-orm'
import { bigserial, boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { connections } from './connections.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Webhooks de entrada (T72; 09-webhooks-entrada.md §3.1–3.3). O token público (≥ 32 bytes aleatórios, base64url)
// é a única autenticação da URL `POST /api/hooks/in/:token`. O processamento fica com a fila `inbound-webhooks` (T81).

export const INBOUND_WEBHOOK_REQUEST_STATUSES = ['pending', 'processed', 'failed', 'skipped'] as const
export type InboundWebhookRequestStatus = (typeof INBOUND_WEBHOOK_REQUEST_STATUSES)[number]

export interface InboundWebhookStep {
  step: string
  status: 'ok' | 'failed' | 'skipped'
  reason?: string
}

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const inboundWebhooks = crm.table(
  'inbound_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    active: boolean('active').notNull().default(true),
    publicToken: text('public_token').notNull(),
    /** WebhookConfig (09 §3.2), validado pelo zod do core. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Mês (`YYYY-MM`, UTC) a que `month_count` se refere; virou o mês, a contagem recomeça. */
    monthPeriod: text('month_period'),
    monthCount: integer('month_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('inbound_webhooks_public_token_uq').on(t.publicToken),
    index('inbound_webhooks_company_idx').on(t.companyId, t.createdAt),
    check('inbound_webhooks_name_len', sql`char_length(${t.name}) between 1 and 120`),
    check('inbound_webhooks_token_len', sql`char_length(${t.publicToken}) >= 43`),
  ],
)

export const inboundWebhookRequests = crm.table(
  'inbound_webhook_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Ordem de chegada (retenção e histórico); uuid não é ordenável. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    companyId: companyId(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => inboundWebhooks.id, { onDelete: 'cascade' }),
    processingStatus: text('processing_status').$type<InboundWebhookRequestStatus>().notNull().default('pending'),
    /** Primeiros 256 KB do corpo (UTF-8). */
    rawBody: text('raw_body').notNull().default(''),
    rawBodyTruncated: boolean('raw_body_truncated').notNull().default(false),
    /** Bytes recebidos. */
    bodySize: integer('body_size').notNull().default(0),
    /** sha256 hex do corpo recebido (dedupe do processador). */
    bodyHash: text('body_hash').notNull().default(''),
    contentType: text('content_type'),
    steps: jsonb('steps').$type<InboundWebhookStep[]>().notNull().default([]),
    error: text('error'),
    reason: text('reason'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('inbound_webhook_requests_webhook_seq_idx').on(t.webhookId, t.seq),
    index('inbound_webhook_requests_webhook_hash_idx').on(t.webhookId, t.bodyHash),
    check('inbound_webhook_requests_status_check', sql`${t.processingStatus} in ('pending', 'processed', 'failed', 'skipped')`),
  ],
)
