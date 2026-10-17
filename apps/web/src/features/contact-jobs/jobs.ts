// Regras dos jobs de contatos da T86 (05 §3.5–3.6, §4): fase e contadores da importação, relatório final (contadores,
// etiquetas criadas, avisos agrupados e erros agrupados por mensagem com as linhas), ordem das exportações recentes
// (`processing` primeiro, depois a mais nova) e tamanho de arquivo legível. Sem React: testável em node.
import { jobDone, type JobDto } from '@/features/contacts/api'
import type { ExportJobDto } from './api'

/** Reserva do SSE: consulta da importação a cada 2 s até terminar (05 §5 nº 17). */
export const IMPORT_POLL_MS = 2_000
/** Exportações recentes: consulta enquanto alguma não terminou (o SSE invalida antes). */
export const EXPORTS_POLL_MS = 10_000
/** Limite do upload (T67: 413 acima disso). */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024

export type ImportPhase = 'starting' | 'reading' | 'importing' | 'completed' | 'failed'

export function importPhase(job: JobDto): ImportPhase {
  if (job.status === 'completed' || job.status === 'failed') return job.status
  const phase = job.progress.phase
  if (phase === 'reading' || phase === 'importing') return phase
  return job.status === 'processing' ? 'reading' : 'starting'
}

export interface ImportCounts {
  created: number
  updated: number
  skipped: number
  errors: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Contadores parciais (progresso) ou finais (`counters` do job concluído). */
export function importCounts(job: JobDto): ImportCounts {
  const src = jobDone(job) && Object.keys(obj(job.counters)).length ? obj(job.counters) : obj(job.progress.counters)
  return { created: num(src.created), updated: num(src.updated), skipped: num(src.skipped), errors: num(src.errors) }
}

export interface ErrorGroup {
  message: string
  count: number
  lines: number[]
}

export interface ImportReport extends ImportCounts {
  labelsCreated: string[]
  errorGroups: ErrorGroup[]
  warningGroups: { message: string; count: number }[]
  /** Erros que não couberam nos grupos (o relatório do servidor guarda até 8 grupos). */
  extraErrors: number
}

/** Relatório final da importação a partir de `job.counters` (T67 `report.ts`). */
export function importReport(job: JobDto): ImportReport {
  const c = obj(job.counters)
  const counts = importCounts(job)
  const errorGroups = (Array.isArray(c.error_groups) ? c.error_groups : []).map((g) => {
    const o = obj(g)
    return {
      message: String(o.message ?? ''),
      count: num(o.count),
      lines: (Array.isArray(o.lines) ? o.lines : []).map(Number).filter((n) => Number.isFinite(n)),
    }
  })
  const warningGroups = (Array.isArray(c.warning_groups) ? c.warning_groups : []).map((g) => {
    const o = obj(g)
    return { message: String(o.message ?? ''), count: num(o.count) }
  })
  const grouped = errorGroups.reduce((n, g) => n + g.count, 0)
  return {
    ...counts,
    labelsCreated: (Array.isArray(c.labels_created) ? c.labels_created : [])
      .map((l) => (typeof l === 'string' ? l : String(obj(l).name ?? '')))
      .filter(Boolean),
    errorGroups,
    warningGroups,
    extraErrors: Math.max(0, counts.errors - grouped),
  }
}

/** Processing/queued primeiro; depois a mais nova (05 §4). */
export function sortRecentExports(items: readonly ExportJobDto[]): ExportJobDto[] {
  const rank = (j: ExportJobDto) => (jobDone(j) ? 1 : 0)
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
  )
}

/** `1536` → `1,5 KB` (base 1024, uma casa decimal a partir de KB). */
export function formatBytes(bytes: number | null | undefined, locale = 'pt-BR'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const text = i === 0 ? String(Math.round(v)) : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)
  return `${text} ${units[i]}`
}

/** Arquivo aceito na importação (extensão .csv e até 50 MB). */
export function importFileError(file: { name: string; size: number }): 'type' | 'size' | null {
  if (!/\.csv$/i.test(file.name)) return 'type'
  if (file.size > IMPORT_MAX_BYTES) return 'size'
  return null
}
