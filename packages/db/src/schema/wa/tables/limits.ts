import { sql } from 'drizzle-orm'
import { check, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sessions } from './tables.js'

// Limites de envio por sessão (T09, AC-T09-05). Colunas nulas = default conservador.
// reduction_factor (0.1–1) só é reduzido automaticamente; volta a 1 apenas por ação manual.
export const sessionLimits = pgTable(
  'session_limits',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    perMinute: integer('per_minute'),
    perHour: integer('per_hour'),
    perDay: integer('per_day'),
    reductionFactor: real('reduction_factor').notNull().default(1),
    reductionReason: text('reduction_reason'),
    reducedAt: timestamp('reduced_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('session_limits_positive_check', sql`coalesce(${t.perMinute}, 1) >= 1 and coalesce(${t.perHour}, 1) >= 1 and coalesce(${t.perDay}, 1) >= 1`),
    check('session_limits_factor_check', sql`${t.reductionFactor} > 0 and ${t.reductionFactor} <= 1`),
  ],
)
