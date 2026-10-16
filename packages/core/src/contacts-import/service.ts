// Importação de contatos (T67): job `contacts_import` (CSV enviado, processado no worker pela fila `imports` da
// T27) e importação síncrona dos contatos do WhatsApp de uma conexão conectada (`WaGateway.listContacts`).
import { and, eq, inArray } from 'drizzle-orm'
import { connections, labels, type Database } from '@crm/db'
import { CONNECTED_STATES, type WaGateway } from '@crm/wa-port'
import { ContactsService } from '../contacts/service'
import { ExportJobs, type JobActor, type JobDto } from '../exports/service'
import { FsExportFileStore, type ExportFileStore } from '../exports/files'
import { getImportKind, registerImportKind, type ImportRunCtx } from '../exports/registry'
import { parseCsv, scanCsv } from './csv'
import { ContactImporter } from './importer'
import { ImportReport, type ImportCounters } from './report'

export const CONTACTS_IMPORT_KIND = 'contacts_import'
export const CONTACTS_IMPORT_MODES = ['upsert'] as const
export type ContactsImportMode = (typeof CONTACTS_IMPORT_MODES)[number]
/** Tamanho máximo do CSV enviado. */
export const CONTACTS_IMPORT_MAX_BYTES = 50 * 1024 * 1024
/** Publica progresso a cada N linhas (além dos marcos de 10% da T27). */
const PROGRESS_EVERY = 200

export const IMPORT_TEMPLATE_FILE_NAME = 'modelo_importacao_contatos.csv'
export const IMPORT_TEMPLATE_HEADER = ['nome', 'telefone', 'email', 'etiquetas', 'estado', 'cidade', 'cep', 'opt_out'] as const

/** Modelo para download: BOM + cabeçalho + 1 exemplo, separado por `;` (Excel pt-BR). */
export function contactsImportTemplate(): string {
  const example = ['Maria Silva', '+55 11 91234-5678', 'maria@exemplo.com', 'Cliente|VIP', 'SP', 'São Paulo', '01001-000', 'nao']
  return `\uFEFF${IMPORT_TEMPLATE_HEADER.join(';')}\r\n${example.join(';')}\r\n`
}

export class ContactsImportError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'session_not_connected',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ContactsImportError'
  }
}

export interface ContactsImportDeps {
  /** Onde o CSV enviado fica (o mesmo ExportFileStore da T27, também no worker). */
  files?: ExportFileStore
  waGateway?: Pick<WaGateway, 'recordConsent' | 'optOut' | 'listContacts' | 'sessions'>
}

let deps: ContactsImportDeps = {}

/**
 * Registra (uma vez por processo) o kind `contacts_import` e atualiza as dependências usadas pelo job. API e worker
 * chamam com as suas; num mesmo processo vale a última configuração.
 */
export function configureContactsImportKind(next: ContactsImportDeps): void {
  deps = { ...deps, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) }
  if (!getImportKind(CONTACTS_IMPORT_KIND)) registerImportKind(CONTACTS_IMPORT_KIND, { permission: 'contacts.edit', run: runContactsImport })
}

/** Opções gravadas no job (`options` da T27). */
export interface ContactsImportOptions {
  mode: ContactsImportMode
  create_missing_labels: boolean
  default_label_ids: string[]
  input_key?: string | null
}

/** Execução do job (worker): pré-leitura (encoding + total), etiquetas e upsert linha a linha. */
export async function runContactsImport(ctx: ImportRunCtx): Promise<{ counters: ImportCounters; rowCount: number }> {
  const files = (deps.files ??= new FsExportFileStore())
  if (!ctx.inputKey) throw new Error('contacts_import: arquivo de entrada ausente')
  const opts = ctx.options as Partial<ContactsImportOptions>
  const report = new ImportReport()
  const importer = new ContactImporter({ db: ctx.db, companyId: ctx.companyId, actor: ctx.userId ? `crm:${ctx.userId}` : null, waGateway: deps.waGateway })

  await ctx.progress({ processed: 0, phase: 'reading' })
  const first = await files.open(ctx.inputKey)
  if (!first) throw new Error('Arquivo da importação não encontrado')
  const { encoding, lines } = await scanCsv(first)
  const total = Math.max(0, lines - 1)
  await ctx.progress({ processed: 0, total, phase: 'importing', counters: report.counters() })

  const source = await files.open(ctx.inputKey)
  if (!source) throw new Error('Arquivo da importação não encontrado')
  let hasPhone = true
  let processed = 0
  const rowOpts = { createMissingLabels: opts.create_missing_labels !== false, defaultLabelIds: opts.default_label_ids ?? [] }
  for await (const { line, record } of parseCsv(source, encoding, (h) => {
    hasPhone = h.hasPhoneColumn
    for (const c of h.ignoredColumns) report.warn(`coluna ignorada: ${c}`)
  })) {
    if (!hasPhone) throw new Error('O arquivo não tem a coluna "telefone"')
    await importer.csvRow(line, record, rowOpts, report)
    processed++
    if (processed % PROGRESS_EVERY === 0) await ctx.progress({ processed, total: Math.max(total, processed), counters: report.counters() })
  }
  await files.delete(ctx.inputKey).catch(() => undefined)
  return { counters: report.counters(), rowCount: processed }
}

export interface CreateImportInput {
  data: Uint8Array
  mode?: string | null
  createMissingLabels?: boolean
  defaultLabelIds?: string[]
}

export interface WhatsAppImportResult {
  imported: number
  updated: number
  skipped: number
  warnings: string[]
}

export class ContactsImportService {
  constructor(private readonly opts: { db: Database; jobs: ExportJobs; files: ExportFileStore; waGateway?: ContactsImportDeps['waGateway'] }) {
    configureContactsImportKind({ files: opts.files, waGateway: opts.waGateway })
  }

  /** Grava o CSV e cria o job (`queued`, enfileirado pela T27). */
  async createCsvImport(actor: JobActor, input: CreateImportInput): Promise<JobDto> {
    const mode = input.mode?.trim() || 'upsert'
    if (!(CONTACTS_IMPORT_MODES as readonly string[]).includes(mode)) throw new ContactsImportError('invalid', 'Modo de importação inválido', { fields: [{ path: 'mode', message: 'use "upsert"' }] })
    if (!input.data.length) throw new ContactsImportError('invalid', 'Arquivo vazio', { fields: [{ path: 'file', message: 'arquivo vazio' }] })
    const labelIds = [...new Set(input.defaultLabelIds ?? [])]
    if (labelIds.length) await this.assertLabels(actor.companyId, labelIds)
    const key = `${actor.companyId}/imports/${crypto.randomUUID()}.csv`
    const w = await this.opts.files.create(key)
    try {
      await new Promise<void>((resolve, reject) => w.stream.write(Buffer.from(input.data), (err) => (err ? reject(err) : resolve())))
      await w.commit()
    } catch (err) {
      await w.abort()
      throw err
    }
    const options: Omit<ContactsImportOptions, 'input_key'> = { mode: 'upsert', create_missing_labels: input.createMissingLabels !== false, default_label_ids: labelIds }
    try {
      return await this.opts.jobs.createImport(actor, CONTACTS_IMPORT_KIND, { inputKey: key, options: { ...options } })
    } catch (err) {
      await this.opts.files.delete(key).catch(() => undefined)
      throw err
    }
  }

  /** Contatos do WhatsApp de uma conexão conectada (síncrono). */
  async importFromWhatsApp(actor: JobActor, connectionId: string): Promise<WhatsAppImportResult> {
    const gw = this.opts.waGateway
    if (!/^[0-9a-f-]{36}$/i.test(connectionId)) throw new ContactsImportError('not_found', 'Conexão não encontrada')
    const [conn] = await this.opts.db
      .select({ sessionId: connections.sessionId })
      .from(connections)
      .where(and(eq(connections.companyId, actor.companyId), eq(connections.id, connectionId)))
    if (!conn) throw new ContactsImportError('not_found', 'Conexão não encontrada')
    if (!gw || !conn.sessionId) throw new ContactsImportError('session_not_connected', 'Conexão não está conectada')
    let state: string | null
    try {
      state = (await gw.sessions.get(conn.sessionId)).status
    } catch {
      state = null
    }
    if (!state || !(CONNECTED_STATES as readonly string[]).includes(state)) throw new ContactsImportError('session_not_connected', 'Conexão não está conectada', { state })

    const list = await gw.listContacts(conn.sessionId)
    const report = new ImportReport()
    const importer = new ContactImporter({ db: this.opts.db, companyId: actor.companyId, actor: actor.userId ? `crm:${actor.userId}` : null, waGateway: gw })
    const contactsSvc = new ContactsService({ db: this.opts.db })
    for (const c of list) {
      if (/@(g\.us|broadcast|newsletter)$/.test(c.jid)) {
        report.skipped++
        continue
      }
      await importer.whatsappContact(c, contactsSvc, report)
    }
    const counters = report.counters()
    return { imported: counters.created, updated: counters.updated, skipped: counters.skipped, warnings: counters.warnings_report }
  }

  private async assertLabels(companyId: string, ids: string[]) {
    const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    const found = valid.length
      ? await this.opts.db.select({ id: labels.id }).from(labels).where(and(eq(labels.companyId, companyId), inArray(labels.id, valid)))
      : []
    if (found.length !== ids.length)
      throw new ContactsImportError('invalid', 'Etiqueta padrão inválida', { fields: [{ path: 'default_label_ids', message: 'etiqueta não encontrada' }] })
  }
}
