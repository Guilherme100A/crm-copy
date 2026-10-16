import { boolean, index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { aiAgents } from './ai-agents.js'
import { companies } from './base.js'
import { chats } from './chats.js'
import { updatedAt, crm } from './schema.js'

// Estado do agente de IA em cada chat (T68): buffer de mensagens, pausa, histórico do LLM (com `providerData`,
// reenviado tal como veio), dados coletados e contadores (áudios, respostas sem avanço).

export const AI_PAUSE_REASONS = ['human', 'transfer_human', 'no_balance', 'stall', 'closed', 'flow'] as const
export type AiPauseReason = (typeof AI_PAUSE_REASONS)[number]

export const aiConversationState = crm.table(
  'ai_conversation_state',
  {
    chatId: uuid('chat_id')
      .primaryKey()
      .references(() => chats.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    paused: boolean('paused').notNull().default(false),
    pausedReason: text('paused_reason').$type<AiPauseReason>(),
    /** Desde quando o agente atende o chat (mensagem humana depois disto pausa com `pause_on_human`). */
    activeSince: timestamp('active_since', { withTimezone: true }).notNull().defaultNow(),
    /** Ids de `crm.messages` no buffer, na ordem de chegada. */
    pending: jsonb('pending').$type<string[]>().notNull().default([]),
    /** Geração do buffer: cada mensagem nova incrementa; o turno só roda se a geração ainda for a mesma. */
    bufferGen: integer('buffer_gen').notNull().default(0),
    /** `LlmMessage[]` dos turnos anteriores (inclui `providerData` do assistente). */
    history: jsonb('history').$type<unknown[]>().notNull().default([]),
    collected: jsonb('collected').$type<Record<string, unknown>>().notNull().default({}),
    audioCount: integer('audio_count').notNull().default(0),
    stallCount: integer('stall_count').notNull().default(0),
    repliesCount: integer('replies_count').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_conversation_state_company_agent_idx').on(t.companyId, t.agentId)],
)
