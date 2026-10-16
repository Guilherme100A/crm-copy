// Execução dos jobs (T27), chamada pelo worker das filas `exports`/`imports`. O export consome o AsyncIterable do
// kind linha a linha e escreve o CSV em streaming; progresso no banco e em `job.progress` (só para o criador) ao
// iniciar, a cada 10% (sem total: a cada `PROGRESS_EVERY_ROWS` linhas) e no fim. Falha → `failed` com a
// mensagem e o temporário descartado: nenhum arquivo parcial fica acessível.
import { and, eq, inArray } from 'drizzle-orm'
import { backgroundJobs, type Database } from '@crm/db'
import type { RealtimePublisher } from '../realtime/publisher'
import { CsvWriter, isCsvDelimiter } from './csv'
import type { ExportFileStore } from './files'
import { getExportKind, getImportKind, type ExportQueryCtx } from './registry'
import { toJobDto, type BackgroundJobRow, type JobDto } from './service'

/** Sem total conhecido, publica o progresso a cada N linhas. */
export const PROGRESS_EVERY_ROWS = 1000
/** Tamanho máximo da mensagem de erro gravada. */
const MAX_ERROR = 500

export interface RunJobDeps {
  db: Database
  files: ExportFileStore
  publisher?: Pick<RealtimePublisher, 'publish'>
  logger?: { warn(obj: object, msg?: string): void; error(obj: object, msg?: string): void }
  now?: () => Date
}

interface Progress {
  processed: number
  total: number | null
  percent: number | null
  [k: string]: unknown
}

const percentOf = (processed: number, total: number | null) =>
  total === null ? null : total <= 0 ? 100 : Math.min(100, Math.floor((processed / total) * 100))

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR) || 'erro desconhecido'

class JobRun {
  private readonly now: () => Date
  constructor(
    readonly deps: RunJobDeps,
    readonly row: BackgroundJobRow,
  ) {
    this.now = deps.now ?? (() => new Date())
  }

  async update(set: Partial<typeof backgroundJobs.$inferInsert>): Promise<BackgroundJobRow> {
    const [r] = await this.deps.db
      .update(backgroundJobs)
      .set({ ...set, updatedAt: this.now() })
      .where(eq(backgroundJobs.id, this.row.id))
      .returning()
    return r!
  }

  async publish(dto: JobDto): Promise<void> {
    if (!this.deps.publisher || !dto.created_by) return
    try {
      await this.deps.publisher.publish(
        this.row.companyId,
        'job.progress',
        { job_id: dto.id, kind: dto.kind, status: dto.status, progress: dto.progress, row_count: dto.row_count, error: dto.error },
        { userId: dto.created_by },
      )
    } catch (err) {
      this.deps.logger?.warn({ err, job_id: dto.id }, 'falha ao publicar job.progress')
    }
  }

  async progress(progress: Progress, extra: Partial<typeof backgroundJobs.$inferInsert> = {}): Promise<void> {
    await this.publish(toJobDto(await this.update({ progress, ...extra })))
  }

  async fail(err: unknown, progress: Progress): Promise<JobDto> {
    const dto = toJobDto(
      await this.update({ status: 'failed', error: errorText(err), progress, fileKey: null, fileSize: null, rowCount: null, finishedAt: this.now() }),
    )
    await this.publish(dto)
    return dto
  }

  ctx(): ExportQueryCtx {
    return { db: this.deps.db, companyId: this.row.companyId, userId: this.row.createdBy, jobId: this.row.id, filters: this.row.filters }
  }
}

/** Marca `processing` (só a partir de `queued`/`processing`, p/ retry); `null` se o job já terminou ou não existe. */
async function claim(deps: RunJobDeps, jobId: string, type: 'export' | 'import'): Promise<BackgroundJobRow | null> {
  const now = (deps.now ?? (() => new Date()))()
  const [row] = await deps.db
    .update(backgroundJobs)
    .set({ status: 'processing', startedAt: now, updatedAt: now, error: null })
    .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.type, type), inArray(backgroundJobs.status, ['queued', 'processing'])))
    .returning()
  return row ?? null
}

/** Processa um export. Devolve o DTO final (`completed` ou `failed`); job inexistente/terminado → `null`. */
export async function runExportJob(deps: RunJobDeps, jobId: string): Promise<JobDto | null> {
  const row = await claim(deps, jobId, 'export')
  if (!row) return null
  const run = new JobRun(deps, row)
  let progress: Progress = { processed: 0, total: null, percent: null }
  const def = getExportKind(row.kind)
  if (!def) return run.fail(new Error(`tipo de exportação não registrado: ${row.kind}`), progress)

  const key = `${row.companyId}/${row.id}.csv`
  let writer: Awaited<ReturnType<ExportFileStore['create']>> | null = null
  try {
    const ctx = run.ctx()
    const total = def.count ? await def.count(ctx) : null
    progress = { processed: 0, total, percent: percentOf(0, total) }
    await run.progress(progress)

    writer = await deps.files.create(key)
    // Erro do stream (disco) não pode virar exceção não tratada: rejeita o `drain`/`commit` pendente.
    writer.stream.on('error', () => undefined)
    const delimiter = isCsvDelimiter(row.options.delimiter) ? row.options.delimiter : ','
    const csv = new CsvWriter(writer.stream, delimiter)
    await csv.header(def.columns.map((c) => c.header))

    let lastStep = 0
    for await (const r of def.query(ctx)) {
      await csv.row(def.columns.map((c) => (c.format ? c.format(r[c.key], r) : r[c.key])))
      const processed = csv.rowCount
      if (total !== null && total > 0) {
        const step = Math.floor(percentOf(processed, total)! / 10)
        if (step > lastStep && processed < total) {
          lastStep = step
          progress = { processed, total, percent: percentOf(processed, total) }
          await run.progress(progress)
        }
      } else if (processed % PROGRESS_EVERY_ROWS === 0) {
        progress = { processed, total, percent: null }
        await run.progress(progress)
      }
    }

    const { size } = await writer.commit()
    writer = null
    const rowCount = csv.rowCount
    progress = { processed: rowCount, total: total ?? rowCount, percent: 100 }
    const done = toJobDto(
      await run.update({
        status: 'completed',
        progress,
        rowCount,
        counters: { rows_written: rowCount },
        fileKey: key,
        fileName: def.fileName?.(row.id) ?? `${row.kind}_${row.id}.csv`,
        fileSize: size,
        finishedAt: new Date(),
      }),
    )
    await run.publish(done)
    return done
  } catch (err) {
    deps.logger?.error({ err, job_id: row.id, kind: row.kind }, 'export falhou')
    if (writer) await writer.abort().catch(() => undefined)
    return run.fail(err, progress)
  }
}

/** Processa um import pelo `run` do kind (progresso pelo `ctx.progress`). */
export async function runImportJob(deps: RunJobDeps, jobId: string): Promise<JobDto | null> {
  const row = await claim(deps, jobId, 'import')
  if (!row) return null
  const run = new JobRun(deps, row)
  let progress: Progress = { processed: 0, total: null, percent: null }
  let counters: Record<string, unknown> = {}
  const def = getImportKind(row.kind)
  if (!def) return run.fail(new Error(`tipo de importação não registrado: ${row.kind}`), progress)
  try {
    await run.progress(progress)
    let lastStep = 0
    let lastRows = 0
    const result = await def.run({
      ...run.ctx(),
      inputKey: typeof row.options.input_key === 'string' ? row.options.input_key : null,
      options: row.options,
      progress: async (p) => {
        const total = p.total === undefined ? progress.total : p.total
        progress = { ...progress, processed: p.processed, total, percent: percentOf(p.processed, total), ...(p.phase ? { phase: p.phase } : {}) }
        if (p.counters) counters = { ...counters, ...p.counters }
        const step = progress.percent === null ? -1 : Math.floor(progress.percent / 10)
        const due = progress.percent === null ? p.processed - lastRows >= PROGRESS_EVERY_ROWS : step > lastStep
        if (due || p.phase) {
          lastStep = Math.max(lastStep, step)
          lastRows = p.processed
          await run.progress(progress, { counters })
        }
      },
    })
    counters = { ...counters, ...result.counters }
    const rowCount = result.rowCount ?? progress.processed
    progress = { ...progress, processed: rowCount, total: progress.total ?? rowCount, percent: 100 }
    const done = toJobDto(await run.update({ status: 'completed', progress, counters, rowCount, finishedAt: new Date() }))
    await run.publish(done)
    return done
  } catch (err) {
    deps.logger?.error({ err, job_id: row.id, kind: row.kind }, 'import falhou')
    await run.update({ counters })
    return run.fail(err, progress)
  }
}
