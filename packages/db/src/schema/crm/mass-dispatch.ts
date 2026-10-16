import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { connections } from './connections.js'
import { contacts } from './contacts.js'
import { flows } from './flows.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Disparos em massa (T60; 10-disparos-em-massa.md §3–4). O envio real é de cada fluxo-alvo, pelo WaGateway
// (pipeline com antiban por sessão); a preparação/agendamento é da T74. Cota mensal por empresa:
// conexões × limite por conexão (global, padrão 500) + bônus do período.

export const MASS_DISPATCH_STATUSES = ['preparing', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const
export type MassDispatchStatus = (typeof MASS_DISPATCH_STATUSES)[number]
export const MASS_DISPATCH_RECIPIENT_STATUSES = ['pending', 'started', 'failed', 'cancelled', 'skipped'] as const
export type MassDispatchRecipientStatus = (typeof MASS_DISPATCH_RECIPIENT_STATUSES)[number]
export const DEFAULT_MASS_DISPATCH_PER_CONNECTION_LIMIT = 500

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const massDispatches = crm.table(
  'mass_dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name'),
    status: text('status').$type<MassDispatchStatus>().notNull().default('preparing'),
    /** Fluxo B do teste A/B (o A é o fluxo de cada alvo). */
    flowBId: uuid('flow_b_id').references(() => flows.id, { onDelete: 'set null' }),
    /** 0 = domingo … 6 = sábado. */
    weekdays: jsonb('weekdays').$type<number[]>().notNull(),
    windowStart: text('window_start').notNull(),
    windowEnd: text('window_end').notNull(),
    timeZone: text('time_zone').notNull(),
    intervalMinSeconds: integer('interval_min_seconds').notNull(),
    intervalMaxSeconds: integer('interval_max_seconds').notNull(),
    dailyLimit: integer('daily_limit'),
    startsSchedulingAt: timestamp('starts_scheduling_at', { withTimezone: true }).notNull(),
    /** Período da cota (`YYYY-MM` no fuso da empresa) em que os destinatários foram contados. */
    quotaPeriod: text('quota_period').notNull(),
    /** Seleção do público como recebida (`ids | all_except + filtros`). */
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    /** `{ phase, scheduled_count, target_count }` (fases da T74). */
    preparationProgress: jsonb('preparation_progress').$type<Record<string, unknown>>().notNull().default({ phase: 'queued', scheduled_count: 0, target_count: 0 }),
    preparationError: text('preparation_error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    firstSentAt: timestamp('first_sent_at', { withTimezone: true }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('mass_dispatches_company_created_idx').on(t.companyId, t.createdAt),
    index('mass_dispatches_company_period_idx').on(t.companyId, t.quotaPeriod),
    check('mass_dispatches_status_ck', sql`${t.status} in ('preparing', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')`),
    check('mass_dispatches_interval_ck', sql`${t.intervalMinSeconds} between 0 and 120 and ${t.intervalMaxSeconds} between ${t.intervalMinSeconds} and 120`),
  ],
)

/** Alvo: conexão (número) + fluxo disparado por ela. */
export const massDispatchTargets = crm.table(
  'mass_dispatch_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => massDispatches.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mass_dispatch_targets_position_uq').on(t.dispatchId, t.position), index('mass_dispatch_targets_company_idx').on(t.companyId, t.dispatchId)],
)

export const massDispatchRecipients = crm.table(
  'mass_dispatch_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => massDispatches.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** Alvo escolhido no agendamento (T74). */
    targetId: uuid('target_id').references(() => massDispatchTargets.id, { onDelete: 'set null' }),
    variant: text('variant').notNull().default('a'),
    status: text('status').$type<MassDispatchRecipientStatus>().notNull().default('pending'),
    /** `opt_out` | `no_phone` | motivo do gateway (T74). */
    skipReason: text('skip_reason'),
    error: text('error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    flowRunId: uuid('flow_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mass_dispatch_recipients_contact_uq').on(t.dispatchId, t.contactId),
    index('mass_dispatch_recipients_dispatch_status_idx').on(t.dispatchId, t.status),
    index('mass_dispatch_recipients_company_idx').on(t.companyId, t.dispatchId),
    check('mass_dispatch_recipients_status_ck', sql`${t.status} in ('pending', 'started', 'failed', 'cancelled', 'skipped')`),
    check('mass_dispatch_recipients_variant_ck', sql`${t.variant} in ('a', 'b')`),
  ],
)

/** Configuração global (linha única `id = 1`), ajustável pelo admin da plataforma (T95). */
export const massDispatchSettings = crm.table(
  'mass_dispatch_settings',
  {
    id: smallint('id').primaryKey().default(1),
    perConnectionLimit: integer('per_connection_limit').notNull().default(DEFAULT_MASS_DISPATCH_PER_CONNECTION_LIMIT),
    updatedAt: updatedAt(),
  },
  (t) => [check('mass_dispatch_settings_singleton_ck', sql`${t.id} = 1`), check('mass_dispatch_settings_limit_ck', sql`${t.perConnectionLimit} >= 0`)],
)

/** Bônus de cota por empresa e período (`YYYY-MM`), somado pelo admin (T95). */
export const massDispatchQuotaBonuses = crm.table(
  'mass_dispatch_quota_bonuses',
  {
    companyId: companyId(),
    period: text('period').notNull(),
    bonus: integer('bonus').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'mass_dispatch_quota_bonuses_pk', columns: [t.companyId, t.period] })],
)
