import { sql } from 'drizzle-orm'
import { check, index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { chats, messages } from './chats.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Agendamento de mensagem ou fluxo num chat (T64; 03-chats F50–F51): até 31 dias à frente, com recorrência.
// Um registro por agendamento: na recorrência, `run_at` avança para a próxima ocorrência (status volta a `pending`).

export const SCHEDULE_KINDS = ['message', 'flow'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export const SCHEDULE_RECURRENCES = ['one_off', 'daily', 'weekly', 'monthly'] as const
export type ScheduleRecurrence = (typeof SCHEDULE_RECURRENCES)[number]

export const SCHEDULE_STATUSES = ['pending', 'sent', 'failed', 'cancelled'] as const
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number]

export const messageSchedules = crm.table(
  'message_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ScheduleKind>().notNull(),
    /** Texto da mensagem (kind `message`). */
    text: text('text'),
    /** Resposta rápida de origem (só referência: o texto já vem resolvido em `text`). */
    quickReplyId: uuid('quick_reply_id'),
    /** Fluxo a disparar (kind `flow`). */
    flowId: uuid('flow_id'),
    /** Próxima execução. */
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    recurrence: text('recurrence').$type<ScheduleRecurrence>().notNull().default('one_off'),
    status: text('status').$type<ScheduleStatus>().notNull().default('pending'),
    runCount: integer('run_count').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastMessageId: uuid('last_message_id').references(() => messages.id, { onDelete: 'set null' }),
    lastFlowRunId: uuid('last_flow_run_id'),
    /** Quem agendou: o envio sai em nome dele. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('message_schedules_company_chat_idx').on(t.companyId, t.chatId, t.runAt),
    index('message_schedules_company_status_idx').on(t.companyId, t.status, t.runAt),
    check('message_schedules_kind_check', sql`${t.kind} in ('message', 'flow')`),
    check('message_schedules_recurrence_check', sql`${t.recurrence} in ('one_off', 'daily', 'weekly', 'monthly')`),
    check('message_schedules_status_check', sql`${t.status} in ('pending', 'sent', 'failed', 'cancelled')`),
    check('message_schedules_content_check', sql`(${t.kind} = 'message' and ${t.text} is not null) or (${t.kind} = 'flow' and ${t.flowId} is not null)`),
  ],
)
