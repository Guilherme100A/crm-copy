import { sql } from 'drizzle-orm'
import { bigint, boolean, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Consumo de IA por empresa (T18): preços com vigência, ledger de créditos e carteira projetada.
// Valores monetários em micro-USD (USD × 10⁶) e créditos em inteiros, como `*_micros` da SPEC 3.6.

const credits = (name: string) => bigint(name, { mode: 'number' })

export const AI_PRICE_KINDS = ['llm', 'tts', 'stt'] as const
export type AiPriceKind = (typeof AI_PRICE_KINDS)[number]
export const aiPriceKindEnum = crm.enum('ai_price_kind', AI_PRICE_KINDS)

/**
 * Preço por provedor/modelo/tipo com vigência: vale a linha de maior `effective_from` <= data do uso.
 * LLM: micro-USD por 1M tokens; cache e reasoning nulos herdam input/output. TTS: `unit_price_micros` por 1M
 * caracteres; STT: `unit_price_micros` por minuto de áudio.
 */
export const llmPrices = crm.table(
  'llm_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    kind: aiPriceKindEnum('kind').notNull().default('llm'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    inputPerMtokMicros: credits('input_per_mtok_micros').notNull().default(0),
    outputPerMtokMicros: credits('output_per_mtok_micros').notNull().default(0),
    cacheReadPerMtokMicros: credits('cache_read_per_mtok_micros'),
    cacheWritePerMtokMicros: credits('cache_write_per_mtok_micros'),
    reasoningPerMtokMicros: credits('reasoning_per_mtok_micros'),
    unitPriceMicros: credits('unit_price_micros'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('llm_prices_model_from_uq').on(t.provider, t.model, t.kind, t.effectiveFrom)],
)

export const ROUNDING_MODES = ['ceil', 'floor', 'round'] as const
export type RoundingMode = (typeof ROUNDING_MODES)[number]
export const roundingModeEnum = crm.enum('ai_rounding_mode', ROUNDING_MODES)

/** Conversão custo → créditos. `company_id` nulo = configuração global; linha da empresa sobrepõe a global. */
export const aiPricingSettings = crm.table(
  'ai_pricing_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    /** Multiplicador em pontos-base: 10000 = 1×. */
    markupBps: integer('markup_bps').notNull(),
    creditsPerUsd: integer('credits_per_usd').notNull(),
    roundingMode: roundingModeEnum('rounding_mode').notNull().default('ceil'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ai_pricing_settings_company_uq').on(t.companyId).where(sql`${t.companyId} is not null`),
    uniqueIndex('ai_pricing_settings_global_uq').on(sql`(true)`).where(sql`${t.companyId} is null`),
  ],
)

export const AI_USAGE_STATUSES = ['charged', 'refunded'] as const
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number]
export const aiUsageStatusEnum = crm.enum('ai_usage_status', AI_USAGE_STATUSES)

/** Um registro por chamada de IA; só inserção (o `status` muda apenas no reembolso). `request_id` é único. */
export const aiUsage = crm.table(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requestId: text('request_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    kind: aiPriceKindEnum('kind').notNull().default('llm'),
    inputTokens: credits('input_tokens').notNull().default(0),
    outputTokens: credits('output_tokens').notNull().default(0),
    cacheReadTokens: credits('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: credits('cache_write_tokens').notNull().default(0),
    reasoningTokens: credits('reasoning_tokens').notNull().default(0),
    /** TTS: caracteres; STT: segundos de áudio. */
    units: credits('units'),
    costMicros: credits('cost_micros').notNull(),
    billedMicros: credits('billed_micros').notNull(),
    credits: credits('credits').notNull(),
    priceId: uuid('price_id').references(() => llmPrices.id, { onDelete: 'set null' }),
    status: aiUsageStatusEnum('status').notNull().default('charged'),
    /** Quem consumiu (ex.: `ai_agent`, `flow`, `translation`) e o id do recurso. */
    source: text('source'),
    sourceId: text('source_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ai_usage_request_uq').on(t.requestId),
    index('ai_usage_company_created_idx').on(t.companyId, t.createdAt),
  ],
)

export const WALLET_STATUSES = ['ok', 'low', 'exhausted'] as const
export type WalletStatus = (typeof WALLET_STATUSES)[number]
export const walletStatusEnum = crm.enum('ai_wallet_status', WALLET_STATUSES)

/** Projeção da carteira (fonte da verdade: `ai_wallet_entries`). Saldo pode ficar negativo até `-max_overrun`. */
export const aiWallets = crm.table('ai_wallets', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  balanceCredits: credits('balance_credits').notNull().default(0),
  lowThresholdCredits: credits('low_threshold_credits').notNull().default(0),
  maxOverrunCredits: credits('max_overrun_credits').notNull().default(0),
  status: walletStatusEnum('status').notNull().default('exhausted'),
  lifetimeCreditedCredits: credits('lifetime_credited_credits').notNull().default(0),
  lifetimeSpentCredits: credits('lifetime_spent_credits').notNull().default(0),
  updatedAt: updatedAt(),
})

export const WALLET_ENTRY_KINDS = ['credit', 'debit', 'refund', 'adjust'] as const
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number]
export const walletEntryKindEnum = crm.enum('ai_wallet_entry_kind', WALLET_ENTRY_KINDS)

/** Ledger de créditos: `amount_credits` com sinal (débito negativo). Um reembolso por uso (índice parcial único). */
export const aiWalletEntries = crm.table(
  'ai_wallet_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    kind: walletEntryKindEnum('kind').notNull(),
    amountCredits: credits('amount_credits').notNull(),
    balanceAfterCredits: credits('balance_after_credits').notNull(),
    usageId: uuid('usage_id').references(() => aiUsage.id, { onDelete: 'set null' }),
    requestId: text('request_id'),
    note: text('note'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_wallet_entries_company_created_idx').on(t.companyId, t.createdAt),
    uniqueIndex('ai_wallet_entries_refund_usage_uq').on(t.usageId).where(sql`${t.kind} = 'refund'`),
    uniqueIndex('ai_wallet_entries_debit_usage_uq').on(t.usageId).where(sql`${t.kind} = 'debit' and ${t.usageId} is not null`),
  ],
)

export const QUOTA_PERIODS = ['day', 'month'] as const
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number]
export const quotaPeriodEnum = crm.enum('ai_quota_period', QUOTA_PERIODS)

/** Cota por empresa e período (aplicada pelo UsageGuard, T24). Limite nulo = sem limite naquela métrica. */
export const aiQuotas = crm.table(
  'ai_quotas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    period: quotaPeriodEnum('period').notNull(),
    maxCredits: credits('max_credits'),
    maxCostMicros: credits('max_cost_micros'),
    maxTokens: credits('max_tokens'),
    /** `true`: bloqueia ao estourar; `false`: só avisa. */
    hard: boolean('hard').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ai_quotas_company_period_uq').on(t.companyId, t.period)],
)
