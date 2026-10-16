import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { messages, sessions } from './tables.js'

// Sugestões de resposta da IA assistiva (T13). Sempre nascem de uma mensagem recebida real (inbound_message_id
// NOT NULL) e só são enviadas após aprovação humana (pending_approval → approved → sent | failed; ou rejected).
export const SUGGESTION_STATUSES = ['pending_approval', 'approved', 'rejected', 'sent', 'failed'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

export const suggestionStatusEnum = pgEnum('suggestion_status', SUGGESTION_STATUSES)

export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    inboundMessageId: uuid('inbound_message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    intent: text('intent').notNull(),
    confidence: real('confidence').notNull(),
    /** Modelo que gerou a sugestão (ou `fallback`). */
    model: text('model').notNull(),
    text: text('text').notNull(),
    status: suggestionStatusEnum('status').notNull().default('pending_approval'),
    /** Mensagem enfileirada pelo SendPipeline na aprovação. */
    sentMessageId: uuid('sent_message_id').references(() => messages.id, { onDelete: 'set null' }),
    /** Código do gate que rejeitou o envio (SPEC 3.4) quando status = failed. */
    error: text('error'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('suggestions_session_status_idx').on(t.sessionId, t.status, t.createdAt),
    // Uma sugestão por mensagem recebida.
    uniqueIndex('suggestions_inbound_message_unique').on(t.inboundMessageId),
    check('suggestions_confidence_check', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
)
