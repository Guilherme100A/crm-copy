import { sql } from 'drizzle-orm'
import { check, doublePrecision, index, integer, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Fluxos (T19, 06-fluxos.md §3.1–3.8): rascunho editável (flows + nodes + actions + edges), versões publicadas
// imutáveis e execuções. Toda tabela tem company_id (SPEC 3.3) com índice começando por ele.
// Os ids da FlowDefinition (nó, ação, aresta) ficam em `key` (únicos no fluxo/nó) e voltam iguais no round-trip.

export const FLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export type FlowStatus = (typeof FLOW_STATUSES)[number]
export const flowStatusEnum = crm.enum('flow_status', FLOW_STATUSES)

export const FLOW_RUN_STATUSES = ['running', 'waiting', 'paused', 'completed', 'failed', 'cancelled'] as const
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number]
export const flowRunStatusEnum = crm.enum('flow_run_status', FLOW_RUN_STATUSES)
/** Estados em que o run ocupa o contato (no máximo um por empresa e contato). */
export const ACTIVE_FLOW_RUN_STATUSES = ['running', 'waiting'] as const satisfies readonly FlowRunStatus[]

export const FLOW_FOLDER_COLORS = ['blue', 'green', 'purple', 'orange', 'red', 'yellow', 'gray'] as const
export type FlowFolderColor = (typeof FLOW_FOLDER_COLORS)[number]

const companyId = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' })

export const flowFolders = crm.table(
  'flow_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    name: text('name').notNull(),
    color: text('color').notNull().default('blue'),
    parentFolderId: uuid('parent_folder_id').references((): AnyPgColumn => flowFolders.id, { onDelete: 'set null' }),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('flow_folders_company_parent_idx').on(t.companyId, t.parentFolderId),
    check('flow_folders_color_check', sql`${t.color} in ('blue', 'green', 'purple', 'orange', 'red', 'yellow', 'gray')`),
    check('flow_folders_not_self_parent', sql`${t.parentFolderId} is null or ${t.parentFolderId} <> ${t.id}`),
  ],
)

export const flows = crm.table(
  'flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    folderId: uuid('folder_id').references(() => flowFolders.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description'),
    status: flowStatusEnum('status').notNull().default('active'),
    /** Ordem dentro da pasta. */
    position: integer('position').notNull().default(0),
    /** `key` do nó de entrada (FlowDefinition.entry). */
    entryKey: text('entry_key').notNull().default('start'),
    variables: jsonb('variables').$type<unknown[]>().notNull().default([]),
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    /** Última versão publicada (null = nunca publicado). */
    publishedVersion: integer('published_version'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('flows_company_folder_idx').on(t.companyId, t.folderId, t.position), index('flows_company_status_idx').on(t.companyId, t.status)],
)

export const flowNodes = crm.table(
  'flow_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    type: text('type').notNull(),
    /** Só em nós `unsupported`: o tipo original. */
    originalType: text('original_type'),
    name: text('name').notNull(),
    description: text('description'),
    positionX: doublePrecision('position_x').notNull(),
    positionY: doublePrecision('position_y').notNull(),
    /** Posição na lista da FlowDefinition (o round-trip preserva a ordem). */
    sortIndex: integer('sort_index').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('flow_nodes_flow_key_uq').on(t.flowId, t.key), index('flow_nodes_company_flow_idx').on(t.companyId, t.flowId)],
)

export const flowNodeActions = crm.table(
  'flow_node_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => flowNodes.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    type: text('type').notNull(),
    order: integer('order').notNull().default(0),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Posição na lista da FlowDefinition (o round-trip preserva a ordem). */
    sortIndex: integer('sort_index').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('flow_node_actions_node_key_uq').on(t.nodeId, t.key), index('flow_node_actions_company_node_idx').on(t.companyId, t.nodeId, t.order)],
)

export const flowEdges = crm.table(
  'flow_edges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    fromNodeId: uuid('from_node_id')
      .notNull()
      .references(() => flowNodes.id, { onDelete: 'cascade' }),
    /** Handle normalizado `kind[:id]` (T10). */
    handle: text('handle').notNull(),
    toNodeId: uuid('to_node_id')
      .notNull()
      .references(() => flowNodes.id, { onDelete: 'cascade' }),
    /** Posição na lista da FlowDefinition (o round-trip preserva a ordem). */
    sortIndex: integer('sort_index').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    // Cada handle de saída tem no máximo uma aresta (06 §3.7).
    uniqueIndex('flow_edges_from_handle_uq').on(t.fromNodeId, t.handle),
    uniqueIndex('flow_edges_flow_key_uq').on(t.flowId, t.key),
    index('flow_edges_company_flow_idx').on(t.companyId, t.flowId),
  ],
)

/** Definição publicada, imutável (trigger `flow_versions_immutable` bloqueia UPDATE). */
export const flowVersions = crm.table(
  'flow_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    /** Sem FK: um SET NULL ao excluir o usuário seria um UPDATE, que o trigger de imutabilidade recusa. */
    publishedByUserId: uuid('published_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('flow_versions_flow_version_uq').on(t.flowId, t.version),
    index('flow_versions_company_flow_idx').on(t.companyId, t.flowId),
    check('flow_versions_version_positive', sql`${t.version} >= 1`),
  ],
)

export const flowRuns = crm.table(
  'flow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => flowVersions.id, { onDelete: 'set null' }),
    version: integer('version'),
    /** Contato do CRM (FK acrescentada quando a tabela de contatos existir, T26). */
    contactId: uuid('contact_id').notNull(),
    chatId: uuid('chat_id'),
    status: flowRunStatusEnum('status').notNull().default('running'),
    currentNodeKey: text('current_node_key'),
    /** Sequência do run (guarda do `flow-step`, T25). */
    seq: integer('seq').notNull().default(0),
    vars: jsonb('vars').$type<Record<string, unknown>>().notNull().default({}),
    /** Estado da espera atual (tipo, prazo, handle de timeout…). */
    wait: jsonb('wait').$type<Record<string, unknown>>(),
    /** Origem do run (gatilho, chat, webhook, disparo…). */
    trigger: jsonb('trigger').$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Um run ativo por contato na empresa (06 §5.5).
    uniqueIndex('flow_runs_active_contact_uq')
      .on(t.companyId, t.contactId)
      .where(sql`${t.status} in ('running', 'waiting')`),
    index('flow_runs_company_flow_status_idx').on(t.companyId, t.flowId, t.status),
    index('flow_runs_company_contact_idx').on(t.companyId, t.contactId, t.startedAt),
  ],
)

export const flowRunSteps = crm.table(
  'flow_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => flowRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    nodeKey: text('node_key').notNull(),
    actionKey: text('action_key'),
    status: text('status').notNull(),
    /** hash(runId, seq, actionId) — impede efeito duplicado no retry (T25). */
    idempotencyKey: text('idempotency_key').notNull(),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('flow_run_steps_idempotency_key_uq').on(t.idempotencyKey), index('flow_run_steps_company_run_idx').on(t.companyId, t.runId, t.seq)],
)

/** Contador do distribuidor (round-robin / proporção) por saída. */
export const flowDistributorCounters = crm.table(
  'flow_distributor_counters',
  {
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    outputKey: text('output_key').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'flow_distributor_counters_pk', columns: [t.companyId, t.flowId, t.nodeKey, t.outputKey] })],
)

/** Código para compartilhar um fluxo com outra empresa (importação, T43). */
export const flowShareCodes = crm.table(
  'flow_share_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: companyId(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('flow_share_codes_code_uq').on(t.code), index('flow_share_codes_company_flow_idx').on(t.companyId, t.flowId)],
)

export const FLOW_TABLES = [
  'flow_folders',
  'flows',
  'flow_nodes',
  'flow_node_actions',
  'flow_edges',
  'flow_versions',
  'flow_runs',
  'flow_run_steps',
  'flow_distributor_counters',
  'flow_share_codes',
] as const
