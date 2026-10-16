// Registro dos tipos de job (T27): cada módulo registra o seu export (`registerExportKind`) ou import
// (`registerImportKind`) no carregamento; API e worker importam o mesmo módulo e enxergam o mesmo registro.
import type { Database } from '@crm/db'
import type { PermissionKey } from '@crm/shared'

export type ExportRow = Record<string, unknown>

export interface ExportQueryCtx {
  db: Database
  companyId: string
  userId: string | null
  jobId: string
  filters: Record<string, unknown>
}

export interface ExportColumn<Row extends ExportRow = ExportRow> {
  key: string
  header: string
  /** Valor da célula (padrão: `row[key]`). */
  format?: (value: unknown, row: Row) => unknown
}

export interface ExportKindDef<Row extends ExportRow = ExportRow> {
  /** Quem não é o criador precisa desta permissão para ver e baixar o job (e para criá-lo). */
  permission: PermissionKey
  columns: readonly ExportColumn<Row>[]
  /** Linhas sob demanda (async generator / cursor): o runner nunca junta tudo em memória. */
  query: (ctx: ExportQueryCtx) => AsyncIterable<Row>
  /** Total esperado (progresso em %). Sem ele, o progresso sai a cada `PROGRESS_EVERY_ROWS` linhas. */
  count?: (ctx: ExportQueryCtx) => Promise<number>
  /** Nome do arquivo baixado (padrão `<kind>_<jobId>.csv`). */
  fileName?: (jobId: string) => string
}

export interface ImportRunCtx extends ExportQueryCtx {
  /** Arquivo de entrada (chave no ExportFileStore) e opções do job. */
  inputKey: string | null
  options: Record<string, unknown>
  /** Atualiza progresso/contadores (gravados e publicados nos marcos de 10%). */
  progress(p: { processed: number; total?: number | null; phase?: string; counters?: Record<string, unknown> }): Promise<void>
}

export interface ImportKindDef {
  permission: PermissionKey
  /** Processa o import; devolve os contadores finais (`created`, `updated`, `skipped`, `errors`…). */
  run: (ctx: ImportRunCtx) => Promise<{ counters?: Record<string, unknown>; rowCount?: number }>
}

const KIND_RE = /^[a-z][a-z0-9_]{1,59}$/

type Registered = { type: 'export'; def: ExportKindDef } | { type: 'import'; def: ImportKindDef }
const kinds = new Map<string, Registered>()

function add(kind: string, entry: Registered): () => void {
  if (!KIND_RE.test(kind)) throw new Error(`kind inválido: ${JSON.stringify(kind)}`)
  if (kinds.has(kind)) throw new Error(`kind "${kind}" já registrado`)
  kinds.set(kind, entry)
  return () => {
    if (kinds.get(kind) === entry) kinds.delete(kind)
  }
}

/** Registra um tipo de exportação. Devolve a função que desfaz o registro (testes). */
export function registerExportKind<Row extends ExportRow>(kind: string, def: ExportKindDef<Row>): () => void {
  if (!def.columns.length) throw new Error(`kind "${kind}" sem colunas`)
  return add(kind, { type: 'export', def: def as unknown as ExportKindDef })
}

export function registerImportKind(kind: string, def: ImportKindDef): () => void {
  return add(kind, { type: 'import', def })
}

export function unregisterExportKind(kind: string): void {
  kinds.delete(kind)
}
export const unregisterImportKind = unregisterExportKind

export function getExportKind(kind: string): ExportKindDef | undefined {
  const k = kinds.get(kind)
  return k?.type === 'export' ? k.def : undefined
}

export function getImportKind(kind: string): ImportKindDef | undefined {
  const k = kinds.get(kind)
  return k?.type === 'import' ? k.def : undefined
}

export function getJobKind(kind: string): Registered | undefined {
  return kinds.get(kind)
}

/** Permissão do kind (`null` se o kind não está registrado neste processo). */
export function jobKindPermission(kind: string): PermissionKey | null {
  return kinds.get(kind)?.def.permission ?? null
}

/**
 * Páginas por keyset → linhas sob demanda. `fetchPage(after, limit)` recebe a última linha da página anterior
 * (ou `null`) e devolve a próxima página; para quando vier menos que `limit`.
 */
export async function* keysetPages<Row extends ExportRow>(
  fetchPage: (after: Row | null, limit: number) => Promise<Row[]>,
  opts: { pageSize?: number } = {},
): AsyncGenerator<Row> {
  const limit = Math.max(1, opts.pageSize ?? 1000)
  let after: Row | null = null
  for (;;) {
    const page = await fetchPage(after, limit)
    for (const row of page) yield row
    if (page.length < limit) return
    after = page[page.length - 1]!
  }
}
