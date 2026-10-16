import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies } from './base.js'
import { chats } from './chats.js'
import { connections } from './connections.js'
import { flowRuns, flows } from './flows.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Gatilhos de início de fluxo (T61; 06 §3.8, 08 §3.3, 17 §3.F): fluxos padrões por conexão, palavras-chave, o
// registro de decisão por mensagem recebida (idempotência) e a janela de 12 h da ação fora do horário.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const DEFAULT_RESPONSE_DELAY_HOURS = 24
export const MIN_RESPONSE_DELAY_HOURS = 1
export const MAX_RESPONSE_DELAY_HOURS = 168

/** Fluxos padrões de uma conexão (um por conexão). Excluir um fluxo referenciado é bloqueado pela API (T28). */
export const connectionFlowConfigs = crm.table(
  'connection_flow_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** Boas-vindas: primeira mensagem do contato nesta conexão. */
    welcomeFlowId: uuid('welcome_flow_id').references(() => flows.id, { onDelete: 'set null' }),
    /** Resposta padrão: nenhuma palavra-chave casou e o contato ficou `default_response_delay_hours` sem escrever. */
    defaultResponseFlowId: uuid('default_response_flow_id').references(() => flows.id, { onDelete: 'set null' }),
    defaultResponseDelayHours: integer('default_response_delay_hours').notNull().default(DEFAULT_RESPONSE_DELAY_HOURS),
    /** Conversa finalizada: o contato reabre uma conversa resolvida. */
    finishedConversationFlowId: uuid('finished_conversation_flow_id').references(() => flows.id, { onDelete: 'set null' }),
    /** Atendimento finalizado: no momento em que o atendimento é concluído. */
    finishedAttendanceFlowId: uuid('finished_attendance_flow_id').references(() => flows.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('connection_flow_configs_connection_uq').on(t.connectionId),
    index('connection_flow_configs_company_idx').on(t.companyId, t.connectionId),
    check('connection_flow_configs_delay_ck', sql`${t.defaultResponseDelayHours} between 1 and 168`),
  ],
)

export const KEYWORD_MATCH_TYPES = ['equals', 'contains', 'different', 'excludes', 'starts_with', 'ends_with'] as const
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number]
export const KEYWORD_RULE_TYPES = ['any', 'all'] as const
export type KeywordRuleType = (typeof KEYWORD_RULE_TYPES)[number]

export interface KeywordCondition {
  keyword: string
  match_type: KeywordMatchType
}

/** Gatilho por palavra-chave de uma conexão: prioridade sobre os fluxos padrões. */
export const keywordTriggers = crm.table(
  'keyword_triggers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    configId: uuid('config_id')
      .notNull()
      .references(() => connectionFlowConfigs.id, { onDelete: 'cascade' }),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    ruleType: text('rule_type').$type<KeywordRuleType>().notNull().default('any'),
    conditions: jsonb('conditions').$type<KeywordCondition[]>().notNull(),
    position: integer('position').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('keyword_triggers_company_config_idx').on(t.companyId, t.configId, t.position),
    index('keyword_triggers_company_flow_idx').on(t.companyId, t.flowId),
    check('keyword_triggers_rule_ck', sql`${t.ruleType} in ('any', 'all')`),
  ],
)

export const FLOW_TRIGGER_OUTCOMES = [
  'run_reply',
  'keyword',
  'welcome',
  'finished_conversation',
  'default_response',
  'suppressed',
  'active_run',
  'none',
] as const
export type FlowTriggerOutcome = (typeof FLOW_TRIGGER_OUTCOMES)[number]

/** Decisão tomada para cada mensagem recebida (`crm.inbound`): idempotência por mensagem e trilha de auditoria. */
export const flowTriggerEvents = crm.table(
  'flow_trigger_events',
  {
    /** `crm.messages.id` da mensagem recebida. */
    messageId: uuid('message_id').primaryKey(),
    companyId: companyId(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull(),
    outcome: text('outcome').$type<FlowTriggerOutcome>().notNull(),
    flowId: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => flowRuns.id, { onDelete: 'set null' }),
    keywordTriggerId: uuid('keyword_trigger_id').references(() => keywordTriggers.id, { onDelete: 'set null' }),
    /** Ação fora do horário executada junto (`message`|`flow`), ou null. */
    outOfHours: text('out_of_hours'),
    createdAt: createdAt(),
  },
  (t) => [index('flow_trigger_events_company_chat_idx').on(t.companyId, t.chatId, t.createdAt)],
)

/** Última ação fora do horário por chat: no máximo uma a cada 12 h. */
export const outOfHoursActions = crm.table(
  'out_of_hours_actions',
  {
    companyId: companyId(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    lastActionAt: timestamp('last_action_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId] }), index('out_of_hours_actions_company_idx').on(t.companyId, t.chatId)],
)
