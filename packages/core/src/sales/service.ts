// Vendas (T34; 02 §3.7): `record` é a entrada ÚNICA para manual, fluxo e webhook. Idempotente por
// (empresa, origem, external_id): repetir atualiza o status sem criar outra venda nem outro `sale.recorded`.
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { buildPageMeta, pageOffset, type PageResponse } from '@crm/shared'
import { companies, contactAttribution, contacts, products, SALE_SOURCES, SALE_STATUSES, sales, type AttributionConfidence, type Database, type SaleSource, type SaleStatus } from '@crm/db'
import type { ChatPublisher } from '../chats/ingest/chat-ingest'
import { normalizeCurrency, salesInvalid, salesNotFound, UUID_RE } from './errors'

export interface RecordSaleInput {
  companyId: string
  source: SaleSource
  externalId?: string | null
  status?: SaleStatus
  amountCents: number
  currency?: string
  soldAt?: Date | string | null
  contactId?: string | null
  connectionId?: string | null
  productId?: string | null
  /** Ausente → herda `contacts.source_id` (AC-T34-05); explícito (inclusive null) vence. */
  sourceId?: string | null
  ctwaClid?: string | null
  /** Revisão 3: confiança de um `sourceId` explícito (default `confirmed_native`, método `informed`). */
  attributionConfidence?: AttributionConfidence
  instanceName?: string | null
  instanceNumber?: string | null
  leadNumber?: string | null
  customerName?: string | null
  /** Emissor de NF do bloco Venda aprovada (T63/T112); ausente não sobrescreve no upsert. */
  noteIssuerId?: string | null
  /** Integração UTMify do bloco Venda aprovada (T63/T113); ausente não sobrescreve no upsert. */
  utmifyIntegrationId?: string | null
}

export interface SaleDto {
  id: string
  amount_cents: number
  currency: string
  sold_at: string
  status: SaleStatus
  source: SaleSource
  external_id: string | null
  source_id: string | null
  ctwa_clid: string | null
  /** Revisão 3: `confirmed_native` | `confirmed_link` | `probable` | `none`. */
  attribution_confidence: AttributionConfidence
  attribution_method: string | null
  contact_id: string | null
  connection_id: string | null
  product_id: string | null
  product_name: string | null
  instance_name: string | null
  instance_number: string | null
  lead_number: string | null
  customer_name: string | null
  note_issuer_id: string | null
  utmify_integration_id: string | null
  created_at: string
  updated_at: string
}

export interface SalesListQuery {
  page: number
  limit: number
  start_date?: string
  end_date?: string
  connection_ids?: string[]
  product_ids?: string[]
  status?: SaleStatus[]
  source?: SaleSource
  contact_id?: string
  skip_total?: boolean
}

export interface SalesServiceOptions {
  db: Database
  /** `RealtimePublisher` (T16) ou espião; publica `sale.recorded` por venda criada. */
  publisher?: Pick<ChatPublisher, 'publish'>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const text = (v: unknown, max = 255) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

const saleColumns = {
  sale: sales,
  productName: products.name,
}

function toDto(r: { sale: typeof sales.$inferSelect; productName: string | null }): SaleDto {
  const s = r.sale
  return {
    id: s.id,
    amount_cents: s.amountCents,
    currency: s.currency,
    sold_at: s.soldAt.toISOString(),
    status: s.status,
    source: s.source,
    external_id: s.externalId,
    source_id: s.sourceId,
    ctwa_clid: s.ctwaClid,
    attribution_confidence: s.attributionConfidence,
    attribution_method: s.attributionMethod,
    contact_id: s.contactId,
    connection_id: s.connectionId,
    product_id: s.productId,
    product_name: r.productName,
    instance_name: s.instanceName,
    instance_number: s.instanceNumber,
    lead_number: s.leadNumber,
    customer_name: s.customerName,
    note_issuer_id: s.noteIssuerId,
    utmify_integration_id: s.utmifyIntegrationId,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  }
}

export class SalesService {
  private readonly db: Database
  private readonly publisher?: SalesServiceOptions['publisher']

  constructor(opts: SalesServiceOptions) {
    this.db = opts.db
    this.publisher = opts.publisher
  }

  /** Registra (ou atualiza, se a origem já mandou esse `external_id`) uma venda (AC-T34-01). */
  async record(input: RecordSaleInput): Promise<{ sale: SaleDto; created: boolean }> {
    const v = await this.validate(input.companyId, input, true)
    const externalId = text(input.externalId, 200)
    const integrations = {
      ...(input.noteIssuerId !== undefined ? { noteIssuerId: text(input.noteIssuerId, 200) } : {}),
      ...(input.utmifyIntegrationId !== undefined ? { utmifyIntegrationId: text(input.utmifyIntegrationId, 200) } : {}),
    }
    const values = { companyId: input.companyId, source: input.source, externalId, ...v, ...integrations }
    // T113: status anterior da venda repetida, para avisar a transição para `refunded`.
    const [prev] = externalId
      ? await this.db
          .select({ status: sales.status })
          .from(sales)
          .where(and(eq(sales.companyId, input.companyId), eq(sales.source, input.source), eq(sales.externalId, externalId)))
          .limit(1)
      : []
    const [row] = externalId
      ? await this.db
          .insert(sales)
          .values(values)
          .onConflictDoUpdate({
            target: [sales.companyId, sales.source, sales.externalId],
            targetWhere: sql`${sales.externalId} is not null`,
            set: {
              status: v.status,
              amountCents: v.amountCents,
              currency: v.currency,
              ...(input.soldAt ? { soldAt: v.soldAt } : {}),
              ...integrations,
              updatedAt: new Date(),
            },
          })
          .returning({ id: sales.id, inserted: sql<boolean>`(xmax = 0)` })
      : await this.db.insert(sales).values(values).returning({ id: sales.id, inserted: sql<boolean>`true` })
    const sale = await this.get(input.companyId, row!.id)
    const created = row!.inserted === true
    if (created && this.publisher) {
      try {
        await this.publisher.publish(input.companyId, 'sale.recorded', { sale_id: sale.id, sale } as never)
      } catch {
        // Realtime é melhor-esforço: a venda já foi gravada.
      }
    }
    if (!created) await this.publishRefund(input.companyId, sale, prev?.status)
    return { sale, created }
  }

  async get(companyId: string, id: string): Promise<SaleDto> {
    if (!UUID_RE.test(id)) throw salesNotFound('Venda')
    const [row] = await this.db
      .select(saleColumns)
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .where(and(eq(sales.companyId, companyId), eq(sales.id, id)))
      .limit(1)
    if (!row) throw salesNotFound('Venda')
    return toDto(row)
  }

  /** Histórico com filtros; período em datas do fuso da empresa, inclusivas (AC-T34-04). */
  async list(companyId: string, q: SalesListQuery): Promise<PageResponse<SaleDto>> {
    const where = await this.filters(companyId, q)
    const rows = await this.db
      .select(saleColumns)
      .from(sales)
      .leftJoin(products, eq(products.id, sales.productId))
      .where(where)
      .orderBy(desc(sales.soldAt), desc(sales.id))
      .limit(q.skip_total ? q.limit + 1 : q.limit)
      .offset(pageOffset(q))
    if (q.skip_total) return { items: rows.slice(0, q.limit).map(toDto), page: buildPageMeta(q, { fetchedCount: rows.length }) }
    const [c] = await this.db.select({ n: sql<number>`count(*)::int` }).from(sales).where(where)
    return { items: rows.map(toDto), page: buildPageMeta(q, { total: Number(c?.n ?? 0) }) }
  }

  async update(companyId: string, id: string, input: Partial<Omit<RecordSaleInput, 'companyId' | 'source' | 'externalId'>>): Promise<SaleDto> {
    const before = await this.get(companyId, id)
    const v = await this.validate(companyId, input, false)
    await this.db.update(sales).set({ ...v, updatedAt: new Date() }).where(and(eq(sales.companyId, companyId), eq(sales.id, id)))
    const sale = await this.get(companyId, id)
    await this.publishRefund(companyId, sale, before.status)
    return sale
  }

  async delete(companyId: string, id: string): Promise<void> {
    await this.get(companyId, id)
    await this.db.delete(sales).where(and(eq(sales.companyId, companyId), eq(sales.id, id)))
  }

  // ---------- internos ----------

  /** T113: venda que passou a `refunded` publica `sale.updated { sale_id, sale, status, previous_status }` (envio à UTMify). */
  private async publishRefund(companyId: string, sale: SaleDto, previous: SaleStatus | undefined): Promise<void> {
    if (!this.publisher || !previous || previous === 'refunded' || sale.status !== 'refunded') return
    try {
      await this.publisher.publish(companyId, 'sale.updated', { sale_id: sale.id, sale, status: sale.status, previous_status: previous } as never)
    } catch {
      // Realtime é melhor-esforço: a venda já foi gravada.
    }
  }

  private async filters(companyId: string, q: SalesListQuery): Promise<SQL | undefined> {
    const errors: { path: string; message: string }[] = []
    if (q.start_date && !DATE_RE.test(q.start_date)) errors.push({ path: 'start_date', message: 'Use YYYY-MM-DD' })
    if (q.end_date && !DATE_RE.test(q.end_date)) errors.push({ path: 'end_date', message: 'Use YYYY-MM-DD' })
    if (q.start_date && !q.end_date) errors.push({ path: 'end_date', message: 'Informe o fim do período' })
    if (q.end_date && !q.start_date) errors.push({ path: 'start_date', message: 'Informe o início do período' })
    if (q.start_date && q.end_date && q.end_date < q.start_date) errors.push({ path: 'end_date', message: 'O fim é antes do início' })
    if (errors.length) throw salesInvalid(errors)
    const conds: (SQL | undefined)[] = [eq(sales.companyId, companyId)]
    if (q.start_date && q.end_date) {
      const [co] = await this.db.select({ tz: companies.timeZone }).from(companies).where(eq(companies.id, companyId)).limit(1)
      const tz = co?.tz ?? 'America/Sao_Paulo'
      // [início do dia inicial, início do dia seguinte ao final) no fuso da empresa.
      conds.push(sql`${sales.soldAt} >= (${q.start_date}::date)::timestamp at time zone ${tz}`)
      conds.push(sql`${sales.soldAt} < ((${q.end_date}::date + 1))::timestamp at time zone ${tz}`)
    }
    if (q.connection_ids?.length) conds.push(inArray(sales.connectionId, q.connection_ids))
    if (q.product_ids?.length) conds.push(inArray(sales.productId, q.product_ids))
    if (q.status?.length) conds.push(inArray(sales.status, q.status))
    if (q.source) conds.push(eq(sales.source, q.source))
    if (q.contact_id) conds.push(eq(sales.contactId, q.contact_id))
    return and(...conds)
  }

  /** Normaliza e valida; `full` exige valor (criação). Herda a atribuição do contato quando ausente. */
  private async validate(companyId: string, input: Partial<RecordSaleInput>, full: boolean) {
    const errors: { path: string; message: string }[] = []
    const out: Partial<typeof sales.$inferInsert> = {}
    if (full && !(SALE_SOURCES as readonly string[]).includes(input.source as string)) errors.push({ path: 'source', message: 'Origem inválida' })
    if (input.amountCents !== undefined || full) {
      if (!Number.isSafeInteger(input.amountCents) || (input.amountCents as number) < 0) errors.push({ path: 'amount_cents', message: 'Valor em centavos (inteiro ≥ 0)' })
      else out.amountCents = input.amountCents
    }
    if (input.currency !== undefined || full) {
      const c = normalizeCurrency(input.currency ?? 'BRL')
      if (!c) errors.push({ path: 'currency', message: 'Moeda ISO 4217 inválida' })
      else out.currency = c
    }
    if (input.status !== undefined || full) {
      const st = input.status ?? 'approved'
      if (!(SALE_STATUSES as readonly string[]).includes(st)) errors.push({ path: 'status', message: 'Status inválido' })
      else out.status = st
    }
    if (input.soldAt !== undefined && input.soldAt !== null) {
      const d = input.soldAt instanceof Date ? input.soldAt : new Date(input.soldAt)
      if (Number.isNaN(d.getTime())) errors.push({ path: 'sold_at', message: 'Data inválida' })
      else out.soldAt = d
    }
    if (input.connectionId !== undefined) {
      if (input.connectionId !== null && !UUID_RE.test(input.connectionId)) errors.push({ path: 'connection_id', message: 'Conexão inválida' })
      else out.connectionId = input.connectionId
    }
    if (input.productId !== undefined) {
      if (input.productId === null) out.productId = null
      else {
        const [p] = UUID_RE.test(input.productId)
          ? await this.db.select({ id: products.id }).from(products).where(and(eq(products.companyId, companyId), eq(products.id, input.productId))).limit(1)
          : []
        if (!p) errors.push({ path: 'product_id', message: 'Produto não encontrado' })
        else out.productId = p.id
      }
    }
    let contact: { sourceId: string | null; ctwaClid: string | null; confidence: AttributionConfidence | null; method: string | null; confidenceSourceId: string | null } | null = null
    if (input.contactId !== undefined) {
      if (input.contactId === null) out.contactId = null
      else {
        const [ct] = UUID_RE.test(input.contactId)
          ? await this.db
              .select({
                id: contacts.id,
                sourceId: contacts.sourceId,
                ctwaClid: contacts.ctwaClid,
                confidence: contactAttribution.confidence,
                method: contactAttribution.method,
                confidenceSourceId: contactAttribution.confidenceSourceId,
              })
              .from(contacts)
              .leftJoin(contactAttribution, eq(contactAttribution.contactId, contacts.id))
              .where(and(eq(contacts.companyId, companyId), eq(contacts.id, input.contactId)))
              .limit(1)
          : []
        if (!ct) errors.push({ path: 'contact_id', message: 'Contato não encontrado' })
        else {
          out.contactId = ct.id
          contact = ct
        }
      }
    }
    // AC-T34-05: o explícito vence (campo a campo); ausente herda do contato.
    // Revisão 3: a venda guarda o nível de confiança da atribuição. Explícito (manual/webhook) = `informed`; herdado =
    // a melhor evidência do contato (nativo > link > provável); sem evidência = `none` (nenhum anúncio inventado).
    if (input.sourceId !== undefined) {
      out.sourceId = text(input.sourceId, 200)
      out.attributionConfidence = out.sourceId ? (input.attributionConfidence ?? 'confirmed_native') : 'none'
      out.attributionMethod = out.sourceId ? 'informed' : null
    } else if (contact) {
      const inherited = inheritAttribution(contact)
      out.sourceId = inherited.sourceId
      out.attributionConfidence = inherited.confidence
      out.attributionMethod = inherited.method
    }
    if (input.ctwaClid !== undefined) out.ctwaClid = text(input.ctwaClid, 500)
    else if (contact) out.ctwaClid = contact.ctwaClid
    for (const [k, col] of [
      ['instanceName', 'instanceName'],
      ['instanceNumber', 'instanceNumber'],
      ['leadNumber', 'leadNumber'],
      ['customerName', 'customerName'],
    ] as const)
      if (input[k] !== undefined) out[col] = text(input[k])
    if (errors.length) throw salesInvalid(errors)
    return out as typeof out & { amountCents: number; currency: string; status: SaleStatus }
  }
}

/**
 * Atribuição herdada do contato (revisão 3): `confirmed_native` usa o `source_id` do cartão do anúncio; link/provável
 * usam o `ad_id` do clique (pode não haver); contato sem evidência registrada mas com `source_id` (anterior aos
 * níveis) conta como nativo (`legacy`); nada → `none`.
 */
export function inheritAttribution(c: { sourceId: string | null; confidence: AttributionConfidence | null; method: string | null; confidenceSourceId: string | null }): {
  sourceId: string | null
  confidence: AttributionConfidence
  method: string | null
} {
  const conf = c.confidence ?? 'none'
  if (conf === 'confirmed_native') return { sourceId: c.sourceId ?? c.confidenceSourceId, confidence: conf, method: c.method }
  if (conf === 'confirmed_link' || conf === 'probable') return { sourceId: c.confidenceSourceId, confidence: conf, method: c.method }
  if (c.sourceId) return { sourceId: c.sourceId, confidence: 'confirmed_native', method: 'legacy' }
  return { sourceId: null, confidence: 'none', method: null }
}
