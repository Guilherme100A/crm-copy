// Ações em massa de contatos (T66): exportação CSV (`contacts_export`, job de export da T27) e exclusão em massa por
// manifesto (`contacts_bulk_delete`, job do tipo import da T27, que só tem export|import). A exclusão roda em lotes
// por keyset (id), cada lote numa transação, e apaga só `crm.*` da empresa: chats, mensagens, cards e o resto caem
// pelas FKs `on delete cascade`; nada em `public.*` (engine WhatsApp) é tocado.
import { and, asc, eq, sql } from 'drizzle-orm'
import { contactLabels, contacts, labels, type Database } from '@crm/db'
import { ExportJobs, type JobActor, type JobDto } from '../exports/service'
import { getExportKind, getImportKind, keysetPages, registerExportKind, registerImportKind, type ImportRunCtx } from '../exports/registry'
import { isCsvDelimiter } from '../exports/csv'
import { SelectionError, parseSelection, selectionToJson, selectionWhere, type ContactSelection } from './filters'

export const CONTACTS_EXPORT_KIND = 'contacts_export'
export const CONTACTS_BULK_DELETE_KIND = 'contacts_bulk_delete'
/** Exportações recentes listadas (05 §5 item 16). */
export const RECENT_EXPORTS = 3
export const DEFAULT_BULK_DELETE_BATCH = 200
export const MANIFEST_VERSION = 1

let batchSize = DEFAULT_BULK_DELETE_BATCH

/** Ajustes do processo (testes usam lotes pequenos para ver o progresso por lote). */
export function configureContactsBulk(opts: { batchSize?: number }): void {
  if (opts.batchSize !== undefined) batchSize = Math.max(1, Math.floor(opts.batchSize))
}

type ExportRow = {
  id: string
  name: string
  phone_e164: string | null
  email: string | null
  labels: string
  state: string | null
  city: string | null
  zip: string | null
  opt_out: boolean
  created_at: Date
  custom_fields: Record<string, unknown> | string
}

/** Seleção gravada no job (`filters` da T27) → seleção. */
function selectionOf(filters: Record<string, unknown>): ContactSelection {
  const raw = (filters.selection ?? filters) as Record<string, unknown>
  return parseSelection(raw)
}

/** Registra os kinds no processo (idempotente: API e worker importam o mesmo módulo). */
export function ensureContactsBulkKinds(): void {
  if (!getExportKind(CONTACTS_EXPORT_KIND)) {
    registerExportKind<ExportRow>(CONTACTS_EXPORT_KIND, {
      permission: 'contacts.view',
      fileName: (id) => `customers_export_${id}.csv`,
      columns: [
        { key: 'name', header: 'Nome' },
        { key: 'phone_e164', header: 'Telefone' },
        { key: 'email', header: 'E-mail' },
        { key: 'labels', header: 'Etiquetas' },
        { key: 'state', header: 'Estado' },
        { key: 'city', header: 'Cidade' },
        { key: 'zip', header: 'CEP' },
        { key: 'opt_out', header: 'Opt-out', format: (v) => (v ? 'sim' : 'não') },
        { key: 'created_at', header: 'Criado em' },
        { key: 'custom_fields', header: 'Campos personalizados' },
      ],
      count: async (ctx) => {
        const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(selectionWhere(ctx.companyId, selectionOf(ctx.filters)))
        return r?.n ?? 0
      },
      query: (ctx) => {
        const selection = selectionOf(ctx.filters)
        const withFields = ctx.filters.include_custom_fields === true
        return keysetPages<ExportRow>(async (after, limit) => {
          const rows = await ctx.db
            .select()
            .from(contacts)
            .where(selectionWhere(ctx.companyId, selection, after?.id ?? null))
            .orderBy(asc(contacts.id))
            .limit(limit)
          const names = await labelNames(ctx.db, rows.map((r) => r.id))
          return rows.map((r) => ({
            id: r.id,
            name: r.name,
            phone_e164: r.phoneE164,
            email: r.email,
            labels: (names.get(r.id) ?? []).join(' | '),
            state: r.state,
            city: r.city,
            zip: r.zip,
            opt_out: r.optOut,
            created_at: r.createdAt,
            custom_fields: withFields && Object.keys(r.customFields ?? {}).length ? r.customFields : '',
          }))
        })
      },
    })
  }
  if (!getImportKind(CONTACTS_BULK_DELETE_KIND)) registerImportKind(CONTACTS_BULK_DELETE_KIND, { permission: 'contacts.delete', run: runBulkDelete })
}

async function labelNames(db: Database, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!ids.length) return out
  const rows = await db
    .select({ contactId: contactLabels.contactId, name: labels.name })
    .from(contactLabels)
    .innerJoin(labels, eq(labels.id, contactLabels.labelId))
    .where(sql`${contactLabels.contactId} = any(${sql.param(ids)}::uuid[])`)
    .orderBy(asc(labels.name))
  for (const r of rows) out.set(r.contactId, [...(out.get(r.contactId) ?? []), r.name])
  return out
}

/** Exclusão em massa: conta os alvos, apaga em lotes (keyset por id) e publica o progresso a cada lote. */
export async function runBulkDelete(ctx: ImportRunCtx): Promise<{ counters: Record<string, unknown>; rowCount: number }> {
  const selection = selectionOf(ctx.filters)
  const [c] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(selectionWhere(ctx.companyId, selection))
  const target = c?.n ?? 0
  let deleted = 0
  let chatsDeleted = 0
  const counters = () => ({ deleted_count: deleted, target_count: target, chats_deleted: chatsDeleted })
  await ctx.progress({ processed: 0, total: target, phase: 'deleting', counters: counters() })
  let after: string | null = null
  for (;;) {
    const batch = await ctx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(selectionWhere(ctx.companyId, selection, after))
      .orderBy(asc(contacts.id))
      .limit(batchSize)
    if (!batch.length) break
    const ids = batch.map((r) => r.id)
    after = ids[ids.length - 1]!
    await ctx.db.transaction(async (tx) => {
      const chats = await tx.execute(sql`delete from crm.chats where company_id = ${ctx.companyId} and contact_id = any(${sql.param(ids)}::uuid[]) returning id`)
      const gone = await tx
        .delete(contacts)
        .where(and(eq(contacts.companyId, ctx.companyId), sql`${contacts.id} = any(${sql.param(ids)}::uuid[])`))
        .returning({ id: contacts.id })
      chatsDeleted += chats.rows.length
      deleted += gone.length
    })
    await ctx.progress({ processed: deleted, total: Math.max(target, deleted), counters: counters() })
    if (batch.length < batchSize) break
  }
  return { counters: counters(), rowCount: deleted }
}

export class ContactsBulkError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContactsBulkError'
  }
}

const invalid = (err: unknown) => (err instanceof SelectionError ? new ContactsBulkError(err.path, err.message) : err)

export interface ExportRequest {
  mode?: unknown
  ids?: unknown
  customer_ids?: unknown
  except_ids?: unknown
  filters?: unknown
  include_custom_fields?: unknown
  delimiter?: unknown
}

export class ContactsBulkService {
  constructor(private readonly jobs: ExportJobs) {
    ensureContactsBulkKinds()
  }

  async createExport(actor: JobActor, req: ExportRequest): Promise<JobDto> {
    let selection: ContactSelection
    try {
      selection = parseSelection(req as Record<string, unknown>)
    } catch (err) {
      throw invalid(err)
    }
    if (req.delimiter !== undefined && !isCsvDelimiter(req.delimiter)) throw new ContactsBulkError('delimiter', 'use "," ou ";"')
    const filters = { selection: selectionToJson(selection), include_custom_fields: req.include_custom_fields === true }
    return this.jobs.create(actor, CONTACTS_EXPORT_KIND, filters, req.delimiter !== undefined ? { delimiter: req.delimiter } : {})
  }

  recentExports(actor: JobActor): Promise<JobDto[]> {
    return this.jobs.list(actor, { kind: CONTACTS_EXPORT_KIND, limit: RECENT_EXPORTS })
  }

  async createBulkDelete(actor: JobActor, manifest: unknown): Promise<JobDto> {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new ContactsBulkError('manifest', 'manifesto inválido')
    const m = manifest as Record<string, unknown>
    if (m.version !== undefined && m.version !== MANIFEST_VERSION) throw new ContactsBulkError('manifest.version', `versão suportada: ${MANIFEST_VERSION}`)
    let selection: ContactSelection
    try {
      selection = parseSelection({ ...m, mode: m.mode ?? 'ids' }, ['ids', 'all_except'])
    } catch (err) {
      throw invalid(err)
    }
    return this.jobs.createImport(actor, CONTACTS_BULK_DELETE_KIND, { filters: { selection: selectionToJson(selection) } })
  }
}
