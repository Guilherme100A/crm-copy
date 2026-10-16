import { sql } from 'drizzle-orm'
import { customType, index, integer, jsonb, text, uuid } from 'drizzle-orm/pg-core'
import { aiAgents } from './ai-agents.js'
import { companies } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Base de conhecimento dos agentes de IA (T52; 07-agentes-ia.md §3.4): fontes `site|pdf|text|file|faq|flow` com
// ingestão em job (`pending → ready|failed` + código de erro) e trechos indexados por busca textual do Postgres
// (`tsvector` 'portuguese' gerado + GIN). Sem embeddings nesta versão.

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

/** bytea <-> Buffer (node-postgres já devolve Buffer). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

export const AI_KNOWLEDGE_KINDS = ['site', 'pdf', 'text', 'file', 'faq', 'flow'] as const
export type AiKnowledgeKind = (typeof AI_KNOWLEDGE_KINDS)[number]
/** `file` é normalizado para `pdf` ou `text` pela extensão (07 §3.4). */
export const AI_KNOWLEDGE_SLOTS = ['site', 'pdf', 'text', 'faq', 'flow'] as const
export type AiKnowledgeSlot = (typeof AI_KNOWLEDGE_SLOTS)[number]
export const AI_KNOWLEDGE_STATUSES = ['pending', 'ready', 'failed'] as const
export type AiKnowledgeStatus = (typeof AI_KNOWLEDGE_STATUSES)[number]

export interface AiKnowledgeFaqItem {
  q: string
  a: string
}

export const aiKnowledgeSources = crm.table(
  'ai_knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => aiAgents.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AiKnowledgeKind>().notNull(),
    slot: text('slot').$type<AiKnowledgeSlot>().notNull(),
    status: text('status').$type<AiKnowledgeStatus>().notNull().default('pending'),
    title: text('title'),
    url: text('url'),
    body: text('body'),
    filename: text('filename'),
    contentType: text('content_type'),
    /** Arquivo enviado (≤ 8 MB), guardado para o reindex. */
    fileData: bytea('file_data'),
    flowId: uuid('flow_id'),
    items: jsonb('items').$type<AiKnowledgeFaqItem[]>(),
    pagesCount: integer('pages_count'),
    questionsCount: integer('questions_count'),
    chunksCount: integer('chunks_count').notNull().default(0),
    /** Código de 07 §3.4 (`site_unreachable`, `empty_pdf`…). */
    errorMessage: text('error_message'),
    /** Detalhe técnico do erro (ex.: `ssrf_blocked`, `http_503`). */
    errorDetail: text('error_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('ai_knowledge_sources_company_agent_idx').on(t.companyId, t.agentId, t.slot)],
)

export const aiKnowledgeChunks = crm.table(
  'ai_knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => aiKnowledgeSources.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    content: text('content').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('portuguese', content)`),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_knowledge_chunks_company_agent_idx').on(t.companyId, t.agentId),
    index('ai_knowledge_chunks_source_idx').on(t.sourceId, t.position),
    index('ai_knowledge_chunks_tsv_idx').using('gin', t.tsv),
  ],
)
