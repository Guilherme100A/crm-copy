// Jobs de exportação/importação (T27): criação, consulta com controle de acesso e download do arquivo.
// Acesso: criador do job ou quem tem a permissão do kind, sempre na mesma empresa (outra empresa → not_found).
import { and, desc, eq } from 'drizzle-orm'
import { backgroundJobs, type Database } from '@crm/db'
import type { Readable } from 'node:stream'
import { isCsvDelimiter, type CsvDelimiter } from './csv'
import type { ExportFileStore } from './files'
import { getJobKind, jobKindPermission } from './registry'

export const EXPORTS_QUEUE = 'exports'
export const IMPORTS_QUEUE = 'imports'

/** Dados do job BullMQ (o estado mora em `crm.background_jobs`). */
export interface BackgroundJobData {
  jobId: string
}

/** `jobId` BullMQ determinístico (sem `:`). */
export const backgroundJobQueueId = (type: 'export' | 'import', jobId: string) => `${type}-${jobId}`

export type BackgroundJobRow = typeof backgroundJobs.$inferSelect

export interface JobDto {
  id: string
  kind: string
  type: 'export' | 'import'
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress: { processed: number; total: number | null; percent: number | null; [k: string]: unknown }
  row_count: number | null
  counters: Record<string, unknown>
  error: string | null
  file_name: string | null
  file_size: number | null
  filters: Record<string, unknown>
  created_by: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** Só com o job `completed` e arquivo. */
  download_url: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toJobDto(row: BackgroundJobRow): JobDto {
  const p = row.progress as Record<string, unknown>
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    status: row.status,
    progress: {
      ...p,
      processed: typeof p.processed === 'number' ? p.processed : 0,
      total: typeof p.total === 'number' ? p.total : null,
      percent: typeof p.percent === 'number' ? p.percent : null,
    },
    row_count: row.rowCount,
    counters: row.counters,
    error: row.error,
    file_name: row.fileName,
    file_size: row.fileSize,
    filters: row.filters,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    started_at: iso(row.startedAt),
    finished_at: iso(row.finishedAt),
    download_url: row.status === 'completed' && row.fileKey ? `/api/jobs/${row.id}/file` : null,
  }
}

export class JobsError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid' | 'conflict',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'JobsError'
  }
}

/** Quem consulta: empresa, usuário e permissões efetivas. */
export interface JobActor {
  companyId: string
  userId: string | null
  perms: ReadonlySet<string>
}

export interface ExportJobsOptions {
  db: Database
  /** Enfileira o processamento (`exports`/`imports`). Sem ele, o job fica `queued` (quem chama processa). */
  enqueue?: (type: 'export' | 'import', data: BackgroundJobData) => Promise<void>
  files?: ExportFileStore
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const JOBS_LIST_DEFAULT_LIMIT = 3
export const JOBS_LIST_MAX_LIMIT = 50

export class ExportJobs {
  constructor(private readonly opts: ExportJobsOptions) {}

  /** Cria um export do kind registrado (exige a permissão do kind) e enfileira. */
  async create(actor: JobActor, kind: string, filters: Record<string, unknown> = {}, options: { delimiter?: unknown } = {}): Promise<JobDto> {
    const entry = getJobKind(kind)
    if (!entry || entry.type !== 'export') throw new JobsError('invalid', `Tipo de exportação desconhecido: ${kind}`, { fields: [{ path: 'kind', message: 'tipo desconhecido' }] })
    if (options.delimiter !== undefined && !isCsvDelimiter(options.delimiter))
      throw new JobsError('invalid', 'Delimitador inválido', { fields: [{ path: 'delimiter', message: 'use "," ou ";"' }] })
    return this.insert(actor, kind, 'export', entry.def.permission, filters, { delimiter: (options.delimiter as CsvDelimiter | undefined) ?? ',' })
  }

  /** Cria um import do kind registrado; `inputKey` = arquivo enviado (no ExportFileStore). */
  async createImport(actor: JobActor, kind: string, input: { inputKey?: string | null; options?: Record<string, unknown>; filters?: Record<string, unknown> } = {}): Promise<JobDto> {
    const entry = getJobKind(kind)
    if (!entry || entry.type !== 'import') throw new JobsError('invalid', `Tipo de importação desconhecido: ${kind}`, { fields: [{ path: 'kind', message: 'tipo desconhecido' }] })
    return this.insert(actor, kind, 'import', entry.def.permission, input.filters ?? {}, { ...input.options, input_key: input.inputKey ?? null })
  }

  private async insert(actor: JobActor, kind: string, type: 'export' | 'import', permission: string, filters: Record<string, unknown>, options: Record<string, unknown>): Promise<JobDto> {
    if (!actor.perms.has(permission)) throw new JobsError('forbidden', 'Permissão insuficiente', { permission })
    const [row] = await this.opts.db
      .insert(backgroundJobs)
      .values({ companyId: actor.companyId, kind, type, filters, options, createdBy: actor.userId })
      .returning()
    if (this.opts.enqueue) await this.opts.enqueue(type, { jobId: row!.id })
    return toJobDto(row!)
  }

  /** Job visível ao ator (criador ou permissão do kind); outra empresa/inexistente → not_found. */
  async get(actor: JobActor, id: string): Promise<JobDto> {
    return toJobDto(await this.accessible(actor, id))
  }

  /** Mais recentes primeiro, só os que o ator pode ver. */
  async list(actor: JobActor, q: { kind?: string | null; limit?: number | null } = {}): Promise<JobDto[]> {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? JOBS_LIST_DEFAULT_LIMIT)), JOBS_LIST_MAX_LIMIT)
    const where = q.kind ? and(eq(backgroundJobs.companyId, actor.companyId), eq(backgroundJobs.kind, q.kind)) : eq(backgroundJobs.companyId, actor.companyId)
    const items: JobDto[] = []
    // Lê em páginas até juntar `limit` visíveis (o filtro de acesso depende do kind registrado).
    for (let offset = 0; items.length < limit; offset += limit * 4) {
      const rows = await this.opts.db
        .select()
        .from(backgroundJobs)
        .where(where)
        .orderBy(desc(backgroundJobs.createdAt), desc(backgroundJobs.id))
        .limit(limit * 4)
        .offset(offset)
      for (const r of rows) if (items.length < limit && canSee(actor, r)) items.push(toJobDto(r))
      if (rows.length < limit * 4) break
    }
    return items
  }

  /** Stream do arquivo do job concluído. */
  async file(actor: JobActor, id: string): Promise<{ stream: Readable; fileName: string; size: number | null; contentType: string }> {
    const row = await this.accessible(actor, id)
    if (row.status !== 'completed' || !row.fileKey) throw new JobsError('conflict', 'O arquivo ainda não está disponível', { status: row.status })
    if (!this.opts.files) throw new Error('ExportJobs: files não configurado')
    const stream = await this.opts.files.open(row.fileKey)
    if (!stream) throw new JobsError('not_found', 'Arquivo não encontrado')
    return { stream, fileName: row.fileName ?? `${row.kind}_${row.id}.csv`, size: row.fileSize, contentType: 'text/csv; charset=utf-8' }
  }

  private async accessible(actor: JobActor, id: string): Promise<BackgroundJobRow> {
    if (!UUID_RE.test(id)) throw new JobsError('not_found', 'Job não encontrado')
    const [row] = await this.opts.db
      .select()
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.companyId, actor.companyId)))
    if (!row) throw new JobsError('not_found', 'Job não encontrado')
    if (!canSee(actor, row)) throw new JobsError('forbidden', 'Permissão insuficiente')
    return row
  }
}

/** Criador do job ou permissão do kind (kind não registrado: só o criador). */
export function canSee(actor: JobActor, row: Pick<BackgroundJobRow, 'createdBy' | 'kind'>): boolean {
  if (actor.userId && row.createdBy === actor.userId) return true
  const perm = jobKindPermission(row.kind)
  return perm !== null && actor.perms.has(perm)
}
