// Processador dos eventos de venda (T73; job `inbound-sales`): relê o mapeamento ATUAL da fonte (o replay reprocessa
// depois de corrigir), resolve o SaleEvent, acha ou cria o contato pelo telefone E.164 (novo: `consent_source =
// 'sale'`), grava o toque de atribuição e registra a venda pela T34 (`source = 'webhook'`, `external_id` idempotente:
// o mesmo id duas vezes = 1 venda com o status atualizado). `sale.recorded` vai pelo publisher injetado (o envelope
// da T125 enfileira o Purchase do Meta CAPI). A T34 só publica na criação: venda que nasce `pending` e depois vira
// `approved` enfileira o Purchase aqui, pelo `capiEnqueue` (mesmo `event_id = sale-<id>` no Meta, que deduplica).
import { and, eq, sql } from 'drizzle-orm'
import { contacts, inboundSaleEvents, products, sales, saleSources, type Database } from '@crm/db'
import { AttributionService } from '../attribution/service'
import { ContactsService } from '../contacts/service'
import { saleJobId, type CapiSaleEnqueue } from '../meta-capi/sales'
import type { RealtimePublisher } from '../realtime/publisher'
import { SalesService } from '../sales/service'
import { hasAttribution, resolveSaleEvent, type SaleEvent } from './mapping'
import type { InboundSaleJobData } from './service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface InboundSaleResult {
  status: 'processed' | 'failed' | 'noop'
  error: string | null
  saleId: string | null
  contactId: string | null
}

export interface InboundSalesProcessorOptions {
  db: Database
  /** Realtime da venda (`sale.recorded`); no worker, o publisher envelopado pela T125. */
  publisher?: Pick<RealtimePublisher, 'publish'>
  /** Fila `meta-capi` (T104): Purchase da venda existente que passa a `approved`. */
  capiEnqueue?: CapiSaleEnqueue
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void }
}

export class InboundSalesProcessor {
  constructor(private readonly opts: InboundSalesProcessorOptions) {}

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  /** Processa o evento (só `pending`; reprocessar um já processado não faz nada). */
  async process(data: InboundSaleJobData): Promise<InboundSaleResult> {
    const db = this.opts.db
    const [ev] = await db
      .select()
      .from(inboundSaleEvents)
      .where(and(eq(inboundSaleEvents.id, data.eventId), eq(inboundSaleEvents.companyId, data.companyId)))
      .limit(1)
    if (!ev || ev.status !== 'pending') return { status: 'noop', error: ev?.error ?? null, saleId: ev?.saleId ?? null, contactId: ev?.contactId ?? null }
    const [source] = await db.select().from(saleSources).where(eq(saleSources.id, ev.saleSourceId)).limit(1)
    if (!source) return this.fail(ev.id, 'sale_source_missing', [])

    let body: unknown
    try {
      body = JSON.parse(ev.rawBody)
    } catch {
      return this.fail(ev.id, 'invalid_json', [])
    }
    const resolved = resolveSaleEvent(body, { mapping: source.mapping, statusMap: source.statusMap, amountUnit: source.amountUnit })
    if (!resolved.ok) {
      const first = resolved.missing[0]
      const error = first ? `missing_path:${first.path || `(${first.field} sem mapeamento)`}` : resolved.errors[0]!
      return this.fail(ev.id, error, resolved.missing)
    }
    const event = resolved.event
    try {
      const contactId = await this.contactFor(source.companyId, event)
      if (hasAttribution(event))
        await new AttributionService(db).recordTouch(source.companyId, contactId, event.attribution, { at: event.sold_at ? new Date(event.sold_at) : this.now(), saleSourceId: source.id })
      const productId = await this.productFor(source.companyId, event.product_id)
      const [prev] = await db
        .select({ status: sales.status })
        .from(sales)
        .where(and(eq(sales.companyId, source.companyId), eq(sales.source, 'webhook'), eq(sales.externalId, event.external_id)))
        .limit(1)
      const { sale, created } = await new SalesService({ db, ...(this.opts.publisher ? { publisher: this.opts.publisher as never } : {}) }).record({
        companyId: source.companyId,
        source: 'webhook',
        externalId: event.external_id,
        status: event.status,
        amountCents: event.amount_cents,
        currency: event.currency,
        soldAt: event.sold_at,
        contactId,
        productId,
        // Ausente → a T34 herda `contacts.source_id`.
        ...(event.attribution.source_id ? { sourceId: event.attribution.source_id } : {}),
        ...(event.attribution.ctwa_clid ? { ctwaClid: event.attribution.ctwa_clid } : {}),
        customerName: event.customer.name,
        leadNumber: event.customer.phone.replace(/\D/g, ''),
      })
      if (!created && prev && prev.status !== 'approved' && sale.status === 'approved') await this.enqueuePurchase(source.companyId, sale.id)
      const now = this.now()
      await db
        .update(inboundSaleEvents)
        .set({ status: 'processed', saleEvent: event as unknown as Record<string, unknown>, error: null, missing: [], saleId: sale.id, contactId, attempts: sql`${inboundSaleEvents.attempts} + 1`, processedAt: now, updatedAt: now })
        .where(eq(inboundSaleEvents.id, ev.id))
      return { status: 'processed', error: null, saleId: sale.id, contactId }
    } catch (err) {
      this.opts.logger?.warn({ err, eventId: ev.id }, 'inbound-sales: falha ao registrar a venda')
      const code = (err as { code?: string }).code
      return this.fail(ev.id, code === 'validation' ? 'invalid_sale' : code === 'conflict' ? 'unique_constraint' : 'processing_error', [], event)
    }
  }

  /** Purchase da venda que virou `approved` depois de criada. jobId próprio: o da criação já foi consumido. */
  private async enqueuePurchase(companyId: string, saleId: string): Promise<void> {
    if (!this.opts.capiEnqueue) return
    try {
      await this.opts.capiEnqueue({ companyId, saleId }, { jobId: `${saleJobId(saleId)}-approved` })
    } catch (err) {
      this.opts.logger?.warn({ err, saleId }, 'inbound-sales: falha ao enfileirar o Purchase da venda aprovada')
    }
  }

  /** Contato pelo telefone E.164; novo com consentimento de venda (`consent_source = 'sale'`). */
  private async contactFor(companyId: string, e: SaleEvent): Promise<string> {
    const [found] = await this.opts.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.phoneE164, e.customer.phone)))
      .limit(1)
    if (found) return found.id
    const created = await new ContactsService({ db: this.opts.db }).create(companyId, { name: e.customer.name ?? e.customer.phone, phone: e.customer.phone, email: e.customer.email }, {}, 'sale')
    // A T26 grava `consent_source = 'manual'` na criação; o contato nasceu de uma venda.
    await this.opts.db.update(contacts).set({ consent: true, consentSource: 'sale' }).where(eq(contacts.id, created.id))
    return created.id
  }

  private async productFor(companyId: string, productId: string | null): Promise<string | null> {
    if (!productId || !UUID_RE.test(productId)) return null
    const [p] = await this.opts.db.select({ id: products.id }).from(products).where(and(eq(products.companyId, companyId), eq(products.id, productId))).limit(1)
    return p?.id ?? null
  }

  private async fail(eventId: string, error: string, missing: { field: string; path: string }[], event?: SaleEvent): Promise<InboundSaleResult> {
    const now = this.now()
    await this.opts.db
      .update(inboundSaleEvents)
      .set({ status: 'failed', error, missing, ...(event ? { saleEvent: event as unknown as Record<string, unknown> } : {}), attempts: sql`${inboundSaleEvents.attempts} + 1`, processedAt: now, updatedAt: now })
      .where(eq(inboundSaleEvents.id, eventId))
    return { status: 'failed', error, saleId: null, contactId: null }
  }
}
