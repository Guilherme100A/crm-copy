// Emissão de NF na venda aprovada (T112; 19-integracoes.md §4.2, §5.4). Cada `sale.recorded` de venda aprovada com
// `note_issuer_id` vira um job `invoices` (`invoiceSalePublisher`, encadeado no publisher das vendas como o
// `capiSalePublisher`); o job chama o emissor e grava o estado em `sale_invoices`, publicando `sale.updated` a cada
// transição (`pending` → `succeeded` | `failed`). Falha do emissor: até 3 tentativas com backoff, depois `failed` com
// a mensagem. Venda ainda não visível (job antes do commit do passo do fluxo, T126): `SaleNotVisibleError`, que NÃO
// conta como tentativa no emissor. `reemit` reabre a emissão (status ≠ pending/succeeded), inclusive com outro emissor.
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { contacts, products, saleInvoices, sales, type Database, type InvoiceEmitStatus } from '@crm/db'
import type { ChatPublisher } from '../chats/ingest/chat-ingest'
import { SaleNotVisibleError } from '../meta-capi/sales'
import { InvoiceIntegrationsService, InvoicingError, invoiceIntegrationNotFound } from './integrations'
import { redactInvoiceSecret, type InvoiceCustomer, type InvoiceProduct, type InvoiceSale } from './port'

export const INVOICES_QUEUE = 'invoices'
/** Tentativas no emissor por emissão (AC-T112-03). */
export const INVOICE_MAX_ATTEMPTS = 3
export const INVOICE_NOT_CONFIGURED = 'Emissor não configurado'
/** Estratégia de backoff do worker (`settings.backoffStrategy`, `apps/worker/src/jobs/invoices`). */
export const INVOICES_BACKOFF = 'invoices'
/**
 * Opções de job da fila `invoices` (API e worker): as 3 chamadas ao emissor + folga para "venda ainda não visível".
 * Uma venda que nunca aparece (rollback) termina `failed` no BullMQ sem linha em `sale_invoices`.
 */
export const INVOICES_JOB_OPTIONS = { attempts: 10, backoff: { type: INVOICES_BACKOFF } } as const

export interface InvoiceJobData {
  companyId: string
  saleId: string
  /** 1 = emissão automática; cada reemissão incrementa (job de geração antiga é ignorado). */
  generation: number
}

/** jobId sem `:` (o BullMQ recusa). */
export const invoiceJobId = (saleId: string, generation: number) => `invoice-${saleId}-${generation}`

export type InvoiceEnqueue = (data: InvoiceJobData, opts: { jobId: string }) => Promise<void>

/** O emissor falhou e ainda há tentativa: o job lança para o BullMQ repetir com backoff. */
export class InvoiceRetryError extends Error {
  readonly retryable = true
  constructor(
    readonly attempts: number,
    message: string,
  ) {
    super(message)
    this.name = 'InvoiceRetryError'
  }
}

export const isInvoiceRetryError = (err: unknown): err is InvoiceRetryError =>
  err instanceof Error && err.name === 'InvoiceRetryError'

export interface SaleInvoiceDto {
  sale_id: string
  /** 19 §4.2; `null` = "Sem emissor". */
  invoice_emit_status: InvoiceEmitStatus | null
  invoice_last_error: string | null
  invoice_integration_id: string | null
  attempts: number
  external_id: string | null
  number: string | null
  pdf_url: string | null
  requested_at: string | null
  succeeded_at: string | null
  updated_at: string | null
  /** Reemissão permitida (status ≠ pending e ≠ succeeded). */
  can_reemit: boolean
}

export type InvoiceProcessOutcome =
  | { status: 'succeeded' | 'failed'; attempts: number; error?: string }
  | { status: 'skipped'; reason: 'no_issuer' | 'not_approved' | 'stale' | 'already_done' }

type Publisher = Pick<ChatPublisher, 'publish'>
type Logger = { warn(obj: object, msg?: string): void; info?(obj: object, msg?: string): void }
type InvoiceRow = typeof saleInvoices.$inferSelect

export interface InvoiceEmissionServiceOptions {
  db: Database
  integrations: InvoiceIntegrationsService
  /** Realtime (`sale.updated`). Ausente: não publica. */
  publisher?: Publisher
  /** Enfileira o job (obrigatório para `reemit`). */
  enqueue?: InvoiceEnqueue
  logger?: Logger
  now?: () => Date
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function saleInvoiceDto(saleId: string, row: InvoiceRow | null | undefined): SaleInvoiceDto {
  const status = row?.status ?? null
  return {
    sale_id: saleId,
    invoice_emit_status: status,
    invoice_last_error: row?.lastError ?? null,
    invoice_integration_id: row?.invoiceIntegrationId ?? null,
    attempts: row?.attempts ?? 0,
    external_id: row?.externalId ?? null,
    number: row?.number ?? null,
    pdf_url: row?.pdfUrl ?? null,
    requested_at: iso(row?.requestedAt),
    succeeded_at: iso(row?.succeededAt),
    updated_at: iso(row?.updatedAt),
    can_reemit: status !== 'pending' && status !== 'succeeded',
  }
}

const reemitSchema = z.object({ invoice_integration_id: z.string('Emissor inválido').trim().nullish() })

export class InvoiceEmissionService {
  private readonly db: Database

  constructor(private readonly opts: InvoiceEmissionServiceOptions) {
    this.db = opts.db
  }

  /** Status da NF de uma venda da empresa (404 se a venda não existe ou é de outra empresa). */
  async forSale(companyId: string, saleId: string): Promise<SaleInvoiceDto> {
    await this.sale(companyId, saleId, true)
    return saleInvoiceDto(saleId, await this.row(saleId))
  }

  /** Status de várias vendas da empresa (ids de outra empresa ou inexistentes são ignorados). */
  async forSales(companyId: string, saleIds: string[]): Promise<SaleInvoiceDto[]> {
    const ids = [...new Set(saleIds.filter((id) => z.uuid().safeParse(id).success))].slice(0, 200)
    if (!ids.length) return []
    const visible = await this.db
      .select({ id: sales.id })
      .from(sales)
      .where(and(eq(sales.companyId, companyId), inArray(sales.id, ids)))
    if (!visible.length) return []
    const rows = await this.db
      .select()
      .from(saleInvoices)
      .where(
        and(
          eq(saleInvoices.companyId, companyId),
          inArray(
            saleInvoices.saleId,
            visible.map((v) => v.id),
          ),
        ),
      )
    const bySale = new Map(rows.map((r) => [r.saleId, r]))
    // Na ordem dos ids pedidos (o Postgres não garante a ordem do `in`).
    const seen = new Set(visible.map((v) => v.id))
    return ids.filter((id) => seen.has(id)).map((id) => saleInvoiceDto(id, bySale.get(id)))
  }

  /** Processa um job `invoices`. */
  async process(data: InvoiceJobData): Promise<InvoiceProcessOutcome> {
    const sale = await this.sale(data.companyId, data.saleId, false)
    if (!sale) throw new SaleNotVisibleError(data.saleId)
    let row = await this.row(sale.id)
    if (!row) {
      if (data.generation !== 1) return { status: 'skipped', reason: 'stale' }
      if (sale.status !== 'approved') return { status: 'skipped', reason: 'not_approved' }
      const issuerId = sale.noteIssuerId?.trim()
      if (!issuerId) return { status: 'skipped', reason: 'no_issuer' }
      const integration = await this.opts.integrations.find(sale.companyId, issuerId)
      const now = this.now()
      await this.db
        .insert(saleInvoices)
        .values({
          companyId: sale.companyId,
          saleId: sale.id,
          invoiceIntegrationId: integration?.id ?? null,
          status: 'pending',
          generation: 1,
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: saleInvoices.saleId })
      row = (await this.row(sale.id))!
      if (row.generation !== 1) return { status: 'skipped', reason: 'stale' }
      await this.publish(sale.companyId, row)
    }
    if (row.generation !== data.generation) return { status: 'skipped', reason: 'stale' }
    if (row.status !== 'pending') return { status: 'skipped', reason: 'already_done' }

    const integration = await this.opts.integrations.find(sale.companyId, row.invoiceIntegrationId)
    const issuer = integration ? this.opts.integrations.issuerFor(integration) : null
    if (!issuer) {
      await this.finish(row, { status: 'failed', lastError: INVOICE_NOT_CONFIGURED })
      return { status: 'failed', attempts: row.attempts, error: INVOICE_NOT_CONFIGURED }
    }

    const attempts = row.attempts + 1
    try {
      const result = await issuer.issue(toInvoiceSale(sale), await this.customer(sale), await this.product(sale))
      await this.finish(row, {
        status: 'succeeded',
        attempts,
        lastError: null,
        externalId: result.external_id,
        number: result.number ?? null,
        pdfUrl: result.pdf_url ?? null,
        succeededAt: this.now(),
      })
      return { status: 'succeeded', attempts }
    } catch (err) {
      const message =
        redactInvoiceSecret(
          err instanceof Error ? err.message : String(err),
          this.opts.integrations.tokenOf(integration!),
        ) || 'Falha na emissão'
      this.opts.logger?.warn({ saleId: sale.id, attempts, error: message }, 'falha ao enviar a venda ao emissor de NF')
      if (attempts < INVOICE_MAX_ATTEMPTS) {
        await this.finish(row, { status: 'pending', attempts, lastError: message })
        throw new InvoiceRetryError(attempts, message)
      }
      await this.finish(row, { status: 'failed', attempts, lastError: message })
      return { status: 'failed', attempts, error: message }
    }
  }

  /**
   * Reenfileira a emissão (`POST /api/sales/:id/reemit-invoice`). Permitida com status ≠ pending/succeeded; sem
   * `invoice_integration_id` usa o emissor da última tentativa ou o `note_issuer_id` da venda.
   */
  async reemit(companyId: string, saleId: string, input: unknown = {}): Promise<SaleInvoiceDto> {
    const parsed = reemitSchema.safeParse(input ?? {})
    if (!parsed.success)
      throw new InvoicingError('validation', 'Dados inválidos', {
        fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      })
    const sale = (await this.sale(companyId, saleId, true))!
    const row = await this.row(sale.id)
    if (row && (row.status === 'pending' || row.status === 'succeeded'))
      throw new InvoicingError(
        'conflict',
        row.status === 'pending'
          ? 'A emissão desta venda já está em andamento'
          : 'A nota desta venda já foi enviada ao emissor',
        {
          invoice_emit_status: row.status,
        },
      )
    const wanted = parsed.data.invoice_integration_id || null
    let integrationId: string | null
    if (wanted) {
      const integration = await this.opts.integrations.find(companyId, wanted)
      if (!integration) throw invoiceIntegrationNotFound()
      integrationId = integration.id
    } else {
      const fallback =
        (await this.opts.integrations.find(companyId, row?.invoiceIntegrationId)) ??
        (await this.opts.integrations.find(companyId, sale.noteIssuerId?.trim()))
      if (!fallback) {
        const message = 'Escolha um emissor de NF'
        throw new InvoicingError('validation', message, { fields: [{ path: 'invoice_integration_id', message }] })
      }
      integrationId = fallback.id
    }
    if (!this.opts.enqueue) throw new Error('invoices: enqueue não configurado')
    const generation = (row?.generation ?? 1) + 1
    const now = this.now()
    const values = {
      invoiceIntegrationId: integrationId,
      status: 'pending' as const,
      attempts: 0,
      generation,
      lastError: null,
      externalId: null,
      number: null,
      pdfUrl: null,
      requestedAt: now,
      succeededAt: null,
      updatedAt: now,
    }
    await this.db
      .insert(saleInvoices)
      .values({ companyId, saleId: sale.id, createdAt: now, ...values })
      .onConflictDoUpdate({ target: saleInvoices.saleId, set: values })
    const fresh = (await this.row(sale.id))!
    await this.publish(companyId, fresh)
    await this.opts.enqueue(
      { companyId, saleId: sale.id, generation: fresh.generation },
      { jobId: invoiceJobId(sale.id, fresh.generation) },
    )
    return saleInvoiceDto(sale.id, fresh)
  }

  // ---------- internos ----------

  private async finish(row: InvoiceRow, patch: Partial<typeof saleInvoices.$inferInsert>): Promise<void> {
    const [updated] = await this.db
      .update(saleInvoices)
      .set({ ...patch, updatedAt: this.now() })
      .where(and(eq(saleInvoices.id, row.id), eq(saleInvoices.generation, row.generation)))
      .returning()
    if (updated) await this.publish(row.companyId, updated)
  }

  private async publish(companyId: string, row: InvoiceRow): Promise<void> {
    if (!this.opts.publisher) return
    const invoice = saleInvoiceDto(row.saleId, row)
    try {
      await this.opts.publisher.publish(companyId, 'sale.updated', {
        sale_id: row.saleId,
        invoice_emit_status: invoice.invoice_emit_status,
        invoice_last_error: invoice.invoice_last_error,
        invoice,
      })
    } catch (err) {
      this.opts.logger?.warn({ err, saleId: row.saleId }, 'falha ao publicar sale.updated')
    }
  }

  private async sale(companyId: string, saleId: string, required: boolean) {
    if (!z.uuid().safeParse(saleId).success) {
      if (required) throw new InvoicingError('not_found', 'Venda não encontrada')
      return null
    }
    const [sale] = await this.db
      .select()
      .from(sales)
      .where(and(eq(sales.companyId, companyId), eq(sales.id, saleId)))
      .limit(1)
    if (!sale && required) throw new InvoicingError('not_found', 'Venda não encontrada')
    return sale ?? null
  }

  private async row(saleId: string): Promise<InvoiceRow | null> {
    const [row] = await this.db.select().from(saleInvoices).where(eq(saleInvoices.saleId, saleId)).limit(1)
    return row ?? null
  }

  private async customer(sale: typeof sales.$inferSelect): Promise<InvoiceCustomer> {
    const [c] = sale.contactId
      ? await this.db
          .select()
          .from(contacts)
          .where(and(eq(contacts.companyId, sale.companyId), eq(contacts.id, sale.contactId)))
          .limit(1)
      : []
    return {
      name: sale.customerName?.trim() || c?.name?.trim() || null,
      email: c?.email ?? null,
      phone: c?.phoneE164 ?? (sale.leadNumber ? `+${sale.leadNumber.replace(/\D/g, '')}` : null),
      state: c?.state ?? null,
      city: c?.city ?? null,
      zip: c?.zip ?? null,
    }
  }

  private async product(sale: typeof sales.$inferSelect): Promise<InvoiceProduct | null> {
    if (!sale.productId) return null
    const [p] = await this.db
      .select({ id: products.publicId, name: products.name })
      .from(products)
      .where(and(eq(products.companyId, sale.companyId), eq(products.id, sale.productId)))
      .limit(1)
    return p ? { id: p.id, name: p.name } : null
  }

  private now = () => this.opts.now?.() ?? new Date()
}

function toInvoiceSale(s: typeof sales.$inferSelect): InvoiceSale {
  return {
    id: s.id,
    amount_cents: s.amountCents,
    currency: s.currency,
    sold_at: s.soldAt.toISOString(),
    status: s.status,
    external_id: s.externalId,
  }
}

interface AnyPublisher {
  publish(companyId: string, type: never, data: never, opts?: never): Promise<unknown>
}

/**
 * Publisher que, além de publicar, enfileira a emissão de NF de cada `sale.recorded` de venda aprovada com
 * `note_issuer_id` (AC-T112-01/02). Sem o DTO da venda no evento, enfileira e o job decide. Falha ao enfileirar só é
 * logada (não derruba o registro da venda).
 */
export function invoiceSalePublisher<P extends AnyPublisher>(
  inner: P,
  deps: { enqueue: InvoiceEnqueue; logger?: Logger },
): P {
  const publish = async (companyId: string, type: string, data: unknown, opts?: unknown) => {
    const out = await inner.publish(companyId, type as never, data as never, opts as never)
    if (type === 'sale.recorded') {
      const d = (data ?? {}) as { sale_id?: unknown; sale?: { status?: unknown; note_issuer_id?: unknown } }
      const saleId = d.sale_id
      const sale = d.sale
      const wants =
        !sale ||
        (sale.status === 'approved' && typeof sale.note_issuer_id === 'string' && sale.note_issuer_id.trim() !== '')
      if (typeof saleId === 'string' && saleId && wants) {
        try {
          await deps.enqueue({ companyId, saleId, generation: 1 }, { jobId: invoiceJobId(saleId, 1) })
        } catch (err) {
          deps.logger?.warn({ err, saleId }, 'falha ao enfileirar a emissão de NF da venda')
        }
      }
    }
    return out
  }
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'publish') return publish
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
}
