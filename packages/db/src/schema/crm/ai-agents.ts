import { bigint, boolean, index, integer, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Agentes de IA (T39; 07-agentes-ia.md §3.1–3.6). Toda tabela tem company_id (SPEC 3.3) com índice começando por ele.

export const AI_AGENT_STATUSES = ['draft', 'active', 'paused'] as const
export type AiAgentStatus = (typeof AI_AGENT_STATUSES)[number]
export const aiAgentStatusEnum = crm.enum('ai_agent_status', AI_AGENT_STATUSES)

export const AI_AGENT_GOALS = ['sell', 'schedule', 'answer', 'qualify'] as const
export type AiAgentGoal = (typeof AI_AGENT_GOALS)[number]
export const aiAgentGoalEnum = crm.enum('ai_agent_goal', AI_AGENT_GOALS)

export const AI_AGENT_PERSONALITIES = ['seller', 'support', 'consultative', 'casual'] as const
export type AiAgentPersonality = (typeof AI_AGENT_PERSONALITIES)[number]
export const aiAgentPersonalityEnum = crm.enum('ai_agent_personality', AI_AGENT_PERSONALITIES)

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

/** Modelo explícito do agente (`LlmModelRef`); nulo = preset `settings.engine` resolvido pela empresa. */
export interface AiAgentModelRef {
  provider: string
  model: string
}

export const aiAgents = crm.table(
  'ai_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull().default('Leo'),
    role: text('role').notNull().default(''),
    /** Avatar pré-definido (`leo-1`…`leo-10`). */
    avatarKey: text('avatar_key').notNull().default('leo-2'),
    /** Avatar enviado (chave do BlobStore); sobrepõe o pré-definido. */
    avatarBlobKey: text('avatar_blob_key'),
    status: aiAgentStatusEnum('status').notNull().default('draft'),
    primaryGoal: aiAgentGoalEnum('primary_goal').notNull().default('sell'),
    purpose: text('purpose').notNull().default(''),
    audience: text('audience').notNull().default(''),
    personality: aiAgentPersonalityEnum('personality').notNull().default('seller'),
    exampleMessages: text('example_messages').notNull().default(''),
    businessRules: text('business_rules').notNull().default(''),
    neverTalkAbout: text('never_talk_about').notNull().default(''),
    useEmojis: boolean('use_emojis').notNull().default(true),
    generatedPrompt: text('generated_prompt').notNull().default(''),
    lastGeneratedPrompt: text('last_generated_prompt').notNull().default(''),
    promptEdited: boolean('prompt_edited').notNull().default(false),
    /** Blocos de prompt travados pela plataforma (não editáveis). */
    lockedBlocks: jsonb('locked_blocks').$type<unknown[]>().notNull().default([]),
    model: jsonb('model').$type<AiAgentModelRef | null>(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_agents_company_status_idx').on(t.companyId, t.status, t.createdAt)],
)

/** AgentSettings (07 §3.2) validadas por zod no core; o JSON guardado é sempre o objeto completo. */
export const aiAgentSettings = crm.table(
  'ai_agent_settings',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    companyId: companyId(),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_agent_settings_company_idx').on(t.companyId)],
)

export const aiAgentSkills = crm.table(
  'ai_agent_skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    whenText: text('when_text').notNull().default(''),
    actionType: text('action_type').notNull(),
    actionParams: jsonb('action_params').$type<Record<string, unknown>>().notNull().default({}),
    scheduleMode: text('schedule_mode').notNull().default('now'),
    silenceAmount: integer('silence_amount').notNull().default(1),
    silenceUnit: text('silence_unit').notNull().default('days'),
    createdAt: createdAt(),
  },
  (t) => [index('ai_agent_skills_company_agent_idx').on(t.companyId, t.agentId, t.position)],
)

export const aiCollectionFields = crm.table(
  'ai_collection_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('ai_collection_fields_agent_key_uq').on(t.agentId, t.key),
    index('ai_collection_fields_company_agent_idx').on(t.companyId, t.agentId, t.position),
  ],
)

/** Arquivos que o agente envia quando o cliente pede (≤ 8 por agente, ≤ 8 MB cada). */
export const aiAgentMedia = crm.table(
  'ai_agent_media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    filename: text('filename'),
    blobKey: text('blob_key').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ai_agent_media_company_agent_idx').on(t.companyId, t.agentId, t.createdAt)],
)
