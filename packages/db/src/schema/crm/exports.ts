import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { companies, users } from './base.js'
import { createdAt, crm, updatedAt } from './schema.js'

// Jobs genéricos de exportação/importação (T27; 05-contatos.md §3.5–3.6, 02-dashboard.md export de vendas).
// Um registro por job; o arquivo gerado fica no ExportFileStore (`file_key`), nunca no banco.

export const BACKGROUND_JOB_TYPES = ['export', 'import'] as const
export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number]
export const BACKGROUND_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const
export type BackgroundJobStatus = (typeof BACKGROUND_JOB_STATUSES)[number]

export const backgroundJobs = crm.table(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Tipo registrado (`contacts_export`, `sales_export`, `contacts_import`…). */
    kind: text('kind').notNull(),
    type: text('type').$type<BackgroundJobType>().notNull(),
    status: text('status').$type<BackgroundJobStatus>().notNull().default('queued'),
    /** `{ processed, total, percent, phase? }`. */
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({ processed: 0, total: null, percent: null }),
    /** Contadores do import (`created`, `updated`, `skipped`, `errors`) ou do export. */
    counters: jsonb('counters').$type<Record<string, unknown>>().notNull().default({}),
    rowCount: integer('row_count'),
    error: text('error'),
    /** Chave no ExportFileStore (`<companyId>/<jobId>.csv`); só preenchida com o arquivo completo. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    fileSize: bigint('file_size', { mode: 'number' }),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
    /** Opções do arquivo (`delimiter`) e do import. */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('background_jobs_company_kind_idx').on(t.companyId, t.kind, t.createdAt),
    index('background_jobs_company_created_idx').on(t.companyId, t.createdAt),
    check('background_jobs_status_ck', sql`${t.status} in ('queued', 'processing', 'completed', 'failed')`),
    check('background_jobs_type_ck', sql`${t.type} in ('export', 'import')`),
  ],
)
