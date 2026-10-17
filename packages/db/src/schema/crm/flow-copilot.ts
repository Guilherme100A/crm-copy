import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { flows } from './flows.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Assistente de fluxo (T93; 07-agentes-ia.md §3.9 "Session/Message", §4 "Sessão"): conversas por fluxo e usuário.
// Status `paused_quota` = cota/saldo de IA acabou no meio do trabalho; `resume` só volta a `active` com saldo.

export const FLOW_COPILOT_SESSION_STATUSES = ['active', 'paused_quota', 'archived'] as const
export type FlowCopilotSessionStatus = (typeof FLOW_COPILOT_SESSION_STATUSES)[number]

export const FLOW_COPILOT_MESSAGE_ROLES = ['user', 'assistant'] as const
export type FlowCopilotMessageRole = (typeof FLOW_COPILOT_MESSAGE_ROLES)[number]

/** `failed` = o turno não terminou (erro do provedor ou cota esgotada). */
export const FLOW_COPILOT_MESSAGE_STATUSES = ['completed', 'failed'] as const
export type FlowCopilotMessageStatus = (typeof FLOW_COPILOT_MESSAGE_STATUSES)[number]

/** Ferramenta executada no turno (só nas mensagens do assistente). */
export interface FlowCopilotToolCallRecord {
  name: string
  input: unknown
  ok: boolean
  /** Resumo devolvido ao modelo (erro de validação quando `ok = false`). */
  output?: unknown
}

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const flowCopilotSessions = crm.table(
  'flow_copilot_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').$type<FlowCopilotSessionStatus>().notNull().default('active'),
    /** Status antes de arquivar (reabrir devolve `paused_quota` se a sessão estava pausada). */
    statusBeforeArchive: text('status_before_archive').$type<FlowCopilotSessionStatus>(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('flow_copilot_sessions_company_flow_idx').on(t.companyId, t.flowId, t.userId, t.createdAt),
    check('flow_copilot_sessions_status_ck', sql`${t.status} in ('active', 'paused_quota', 'archived')`),
  ],
)

export const flowCopilotMessages = crm.table(
  'flow_copilot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => flowCopilotSessions.id, { onDelete: 'cascade' }),
    role: text('role').$type<FlowCopilotMessageRole>().notNull(),
    content: text('content').notNull(),
    status: text('status').$type<FlowCopilotMessageStatus>().notNull().default('completed'),
    /** Id do cliente (idempotência do envio). */
    clientMessageId: text('client_message_id'),
    toolCalls: jsonb('tool_calls').$type<FlowCopilotToolCallRecord[]>().notNull().default([]),
    /** Créditos debitados no turno (mensagens do assistente). */
    credits: integer('credits').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [
    index('flow_copilot_messages_company_session_idx').on(t.companyId, t.sessionId, t.createdAt),
    uniqueIndex('flow_copilot_messages_client_uq')
      .on(t.sessionId, t.clientMessageId)
      .where(sql`${t.clientMessageId} is not null`),
    check('flow_copilot_messages_role_ck', sql`${t.role} in ('user', 'assistant')`),
  ],
)
