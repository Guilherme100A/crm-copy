// Envio de vendas à UTMify (T113; 11-facebook-ads.md §3.6, §3.7). Cada `sale.recorded` de venda aprovada e cada
// `sale.updated` de venda que passou a reembolsada (`SalesService`), com `utmify_integration_id`, vira um job `utmify`
// (`utmifySalePublisher`, encadeado no publisher das vendas depois do emissor de NF). O job envia a venda com a
// atribuição do contato (último toque, T73) e grava o estado em `sale_utmify_events` — uma linha por (venda, status):
// o mesmo evento nunca é enviado duas vezes (AC-T113-02). Falha da UTMify: até 3 chamadas com backoff, depois `failed`
// com a mensagem (AC-T113-03), visível em `GET /api/sales/:id/utmify` e no `sale.updated`. Venda ainda não visível (job
// antes do commit do passo do fluxo, T126): `SaleNotVisibleError`, que NÃO conta como chamada à UTMify.
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import {
  contacts,
  products,
  sales,
  saleUtmifyEvents,
  type Database,
  type UtmifySaleStatus,
  type UtmifySendStatus,
} from '@crm/db'
import { AttributionService } from '../attribution/service'
import type { ChatPublisher } from '../chats/ingest/chat-ingest'
import { SaleNotVisibleError } from '../meta-capi/sales'
import { UtmifyError, UtmifyIntegrationsService } from './integrations'
import { emptyAttribution, redactTrackerSecret, type SaleAttribution, type TrackedSale } from './port'

export const UTMIFY_QUEUE = 'utmify'
/** Chamadas à UTMify por envio (AC-T113-03). */
export const UTMIFY_MAX_ATTEMPTS = 3
export const UTMIFY_NOT_CONFIGURED = 'Integração UTMify não configurada'
export const UTMIFY_SUPERSEDED = 'Venda reembolsada antes do envio da aprovação'
/** Estratégia de backoff do worker (`settings.backoffStrategy`, `apps/worker/src/jobs/utmify`). */
export const UTMIFY_BACKOFF = 'utmify'
/**
 * Opções de job da fila `utmify` (API e worker): as 3 chamadas + folga para "venda ainda não visível". Uma venda que
 * nunca aparece (rollback) termina `failed` no BullMQ sem linha em `sale_utmify_events`.
 */
export const UTMIFY_JOB_OPTIONS = { attempts: 10, backoff: { type: UTMIFY_BACKOFF } } as const

export interface UtmifyJobData {
  companyId: string
  saleId: string
  /** Status da venda a enviar. */
  status: UtmifySaleStatus
}

/** jobId sem `:` (o BullMQ recusa): um por (venda, status). */
export const utmifyJobId = (saleId: string, status: UtmifySaleStatus) => `utmify-${saleId}-${status}`

export type UtmifyEnqueue = (data: UtmifyJobData, opts: { jobId: string }) => Promise<void>

/** Enfileira o envio de `status` da venda com o jobId determinístico. */
export const enqueueUtmifySale = (
  enqueue: UtmifyEnqueue,
  companyId: string,
  saleId: string,
  status: UtmifySaleStatus,
) => enqueue({ companyId, saleId, status }, { jobId: utmifyJobId(saleId, status) })

/** A UTMify falhou e ainda há chamada: o job lança para o BullMQ repetir com backoff. */
export class UtmifyRetryError extends Error {
  readonly retryable = true
  constructor(
    readonly attempts: number,
    message: string,
  ) {
    super(message)
    this.name = 'UtmifyRetryError'
  }
}

export const isUtmifyRetryError = (err: unknown): err is UtmifyRetryError =>
  err instanceof Error && err.name === 'UtmifyRetryError'

export interface SaleUtmifyEventDto {
  sale_status: UtmifySaleStatus
  status: UtmifySendStatus
  attempts: number
  last_error: string | null
  utmify_integration_id: string | null
  requested_at: string
  sent_at: string | null
  updated_at: string
}

export interface SaleUtmifyDto {
  sale_id: string
  /** Integração escolhida na venda (`sales.utmify_integration_id`); `null` = "Não enviar para UTMify". */
  utmify_integration_id: string | null
  /** Estado do envio mais recente (reembolso > aprovação); `null` = nada enviado. */
  utmify_status: UtmifySendStatus | null
  utmify_last_error: string | null
  /** Envios por status da venda (aprovada primeiro). */
  events: SaleUtmifyEventDto[]
}

export type UtmifyProcessOutcome =
  | { status: 'succeeded' | 'failed'; attempts: number; error?: string }
  | { status: 'skipped'; reason: 'no_integration' | 'status_changed' | 'superseded' | 'already_done' }

type Publisher = Pick<ChatPublisher, 'publish'>
type Logger = { warn(obj: object, msg?: string): void; info?(obj: object, msg?: string): void }
type EventRow = typeof saleUtmifyEvents.$inferSelect
type SaleRow = typeof sales.$inferSelect

export interface UtmifySendServiceOptions {
  db: Database
  integrations: UtmifyIntegrationsService
  /** Realtime (`sale.updated`). Ausente: não publica. */
  publisher?: Publisher
  logger?: Logger
  now?: () => Date
}

const ORDER: Record<UtmifySaleStatus, number> = { approved: 0, refunded: 1 }

function eventDto(r: EventRow): SaleUtmifyEventDto {
  return {
    sale_status: r.saleStatus,
    status: r.status,
    attempts: r.attempts,
    last_error: r.lastError,
    utmify_integration_id: r.utmifyIntegrationId,
    requested_at: r.requestedAt.toISOString(),
    sent_at: r.sentAt ? r.sentAt.toISOString() : null,
    updated_at: r.updatedAt.toISOString(),
  }
}

export function saleUtmifyDto(saleId: string, integrationId: string | null, rows: EventRow[]): SaleUtmifyDto {
  const events = [...rows].sort((a, b) => ORDER[a.saleStatus] - ORDER[b.saleStatus]).map(eventDto)
  const latest = events[events.length - 1]
  return {
    sale_id: saleId,
    utmify_integration_id: integrationId,
    utmify_status: latest?.status ?? null,
    utmify_last_error: latest?.last_error ?? null,
    events,
  }
}

export class UtmifySendService {
  private readonly db: Database

  constructor(private readonly opts: UtmifySendServiceOptions) {
    this.db = opts.db
  }

  /** Envios UTMify de uma venda da empresa (404 se a venda não existe ou é de outra empresa). */
  async forSale(companyId: string, saleId: string): Promise<SaleUtmifyDto> {
    const sale = (await this.sale(companyId, saleId, true))!
    return saleUtmifyDto(sale.id, sale.utmifyIntegrationId, await this.rows([sale.id]))
  }

  /** Envios de várias vendas da empresa (ids de outra empresa ou inexistentes são ignorados). */
  async forSales(companyId: string, saleIds: string[]): Promise<SaleUtmifyDto[]> {
    const ids = [...new Set(saleIds.filter((id) => z.uuid().safeParse(id).success))].slice(0, 200)
    if (!ids.length) return []
    const visible = await this.db
      .select({ id: sales.id, integrationId: sales.utmifyIntegrationId })
      .from(sales)
      .where(and(eq(sales.companyId, companyId), inArray(sales.id, ids)))
    if (!visible.length) return []
    const rows = await this.rows(visible.map((v) => v.id))
    const byId = new Map(visible.map((v) => [v.id, v.integrationId]))
    // Na ordem dos ids pedidos (o Postgres não garante a ordem do `in`).
    return ids
      .filter((id) => byId.has(id))
      .map((id) =>
        saleUtmifyDto(
          id,
          byId.get(id) ?? null,
          rows.filter((r) => r.saleId === id),
        ),
      )
  }

  /** Processa um job `utmify`. */
  async process(data: UtmifyJobData): Promise<UtmifyProcessOutcome> {
    const sale = await this.sale(data.companyId, data.saleId, false)
    if (!sale) throw new SaleNotVisibleError(data.saleId)
    let row = await this.row(sale.id, data.status)
    if (row && row.status !== 'pending') return { status: 'skipped', reason: 'already_done' }

    // A venda mudou de status depois do enfileiramento: o envio do status novo cobre o pedido.
    const statusOk =
      data.status === 'refunded' ? sale.status === 'refunded' : sale.status === 'approved' || sale.status === 'refunded'
    const refunded = data.status === 'approved' ? await this.row(sale.id, 'refunded') : null
    if (!statusOk || refunded?.status === 'succeeded') {
      if (row)
        await this.finish(sale, row, {
          status: 'failed',
          lastError: statusOk ? UTMIFY_SUPERSEDED : 'O status da venda mudou antes do envio',
        })
      return { status: 'skipped', reason: statusOk ? 'superseded' : 'status_changed' }
    }

    if (!row) {
      const integrationId = sale.utmifyIntegrationId?.trim()
      if (!integrationId) return { status: 'skipped', reason: 'no_integration' }
      const integration = await this.opts.integrations.find(sale.companyId, integrationId)
      const now = this.now()
      await this.db
        .insert(saleUtmifyEvents)
        .values({
          companyId: sale.companyId,
          saleId: sale.id,
          saleStatus: data.status,
          utmifyIntegrationId: integration?.id ?? null,
          status: 'pending',
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [saleUtmifyEvents.saleId, saleUtmifyEvents.saleStatus] })
      row = (await this.row(sale.id, data.status))!
      if (row.status !== 'pending') return { status: 'skipped', reason: 'already_done' }
      await this.publish(sale)
    }

    const integration = await this.opts.integrations.find(sale.companyId, row.utmifyIntegrationId)
    const tracker = integration ? this.opts.integrations.trackerFor(integration) : null
    if (!tracker) {
      await this.finish(sale, row, { status: 'failed', lastError: UTMIFY_NOT_CONFIGURED })
      return { status: 'failed', attempts: row.attempts, error: UTMIFY_NOT_CONFIGURED }
    }

    const attempts = row.attempts + 1
    try {
      await tracker.pushSale(await this.trackedSale(sale, data.status, row), await this.attribution(sale))
      await this.finish(sale, row, { status: 'succeeded', attempts, lastError: null, sentAt: this.now() })
      return { status: 'succeeded', attempts }
    } catch (err) {
      const message =
        redactTrackerSecret(
          err instanceof Error ? err.message : String(err),
          this.opts.integrations.tokenOf(integration!),
        ) || 'Falha no envio à UTMify'
      this.opts.logger?.warn(
        { saleId: sale.id, saleStatus: data.status, attempts, error: message },
        'falha ao enviar a venda à UTMify',
      )
      if (attempts < UTMIFY_MAX_ATTEMPTS) {
        await this.finish(sale, row, { status: 'pending', attempts, lastError: message })
        throw new UtmifyRetryError(attempts, message)
      }
      await this.finish(sale, row, { status: 'failed', attempts, lastError: message })
      return { status: 'failed', attempts, error: message }
    }
  }

  // ---------- internos ----------

  private async finish(
    sale: SaleRow,
    row: EventRow,
    patch: Partial<typeof saleUtmifyEvents.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(saleUtmifyEvents)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(saleUtmifyEvents.id, row.id))
    await this.publish(sale)
  }

  private async publish(sale: SaleRow): Promise<void> {
    if (!this.opts.publisher) return
    const utmify = saleUtmifyDto(sale.id, sale.utmifyIntegrationId, await this.rows([sale.id]))
    try {
      await this.opts.publisher.publish(sale.companyId, 'sale.updated', {
        sale_id: sale.id,
        utmify_status: utmify.utmify_status,
        utmify_last_error: utmify.utmify_last_error,
        utmify,
      })
    } catch (err) {
      this.opts.logger?.warn({ err, saleId: sale.id }, 'falha ao publicar sale.updated')
    }
  }

  private async sale(companyId: string, saleId: string, required: boolean): Promise<SaleRow | null> {
    if (!z.uuid().safeParse(saleId).success) {
      if (required) throw new UtmifyError('not_found', 'Venda não encontrada')
      return null
    }
    const [sale] = await this.db
      .select()
      .from(sales)
      .where(and(eq(sales.companyId, companyId), eq(sales.id, saleId)))
      .limit(1)
    if (!sale && required) throw new UtmifyError('not_found', 'Venda não encontrada')
    return sale ?? null
  }

  private async row(saleId: string, status: UtmifySaleStatus): Promise<EventRow | null> {
    const [row] = await this.db
      .select()
      .from(saleUtmifyEvents)
      .where(and(eq(saleUtmifyEvents.saleId, saleId), eq(saleUtmifyEvents.saleStatus, status)))
      .limit(1)
    return row ?? null
  }

  private rows(saleIds: string[]): Promise<EventRow[]> {
    return this.db.select().from(saleUtmifyEvents).where(inArray(saleUtmifyEvents.saleId, saleIds))
  }

  private async contact(sale: SaleRow) {
    if (!sale.contactId) return null
    const [c] = await this.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, sale.companyId), eq(contacts.id, sale.contactId)))
      .limit(1)
    return c ?? null
  }

  private async trackedSale(sale: SaleRow, status: UtmifySaleStatus, row: EventRow): Promise<TrackedSale> {
    const c = await this.contact(sale)
    const [p] = sale.productId
      ? await this.db
          .select({ id: products.publicId, name: products.name })
          .from(products)
          .where(and(eq(products.companyId, sale.companyId), eq(products.id, sale.productId)))
          .limit(1)
      : []
    const soldAt = sale.soldAt.toISOString()
    return {
      id: sale.id,
      status,
      amount_cents: sale.amountCents,
      currency: sale.currency,
      sold_at: soldAt,
      approved_at: soldAt,
      refunded_at: status === 'refunded' ? row.requestedAt.toISOString() : null,
      customer: {
        name: sale.customerName?.trim() || c?.name?.trim() || null,
        email: c?.email ?? null,
        phone: c?.phoneE164 ?? (sale.leadNumber ? `+${sale.leadNumber.replace(/\D/g, '')}` : null),
      },
      product: p ? { id: p.id, name: p.name } : null,
    }
  }

  /** Último toque do contato (T73; decisão do Orquestrador); `source_id`/`ctwa_clid` da venda vencem. */
  private async attribution(sale: SaleRow): Promise<SaleAttribution> {
    const out = emptyAttribution()
    const touch = sale.contactId
      ? (await new AttributionService(this.db).get(sale.companyId, sale.contactId))?.last_touch
      : null
    if (touch) {
      out.utm_source = touch.utm_source
      out.utm_medium = touch.utm_medium
      out.utm_campaign = touch.utm_campaign
      out.utm_content = touch.utm_content
      out.utm_term = touch.utm_term
    }
    const c = sale.contactId && (!sale.sourceId || !sale.ctwaClid) ? await this.contact(sale) : null
    out.source_id = sale.sourceId ?? touch?.source_id ?? c?.sourceId ?? null
    out.ctwa_clid = sale.ctwaClid ?? touch?.ctwa_clid ?? c?.ctwaClid ?? null
    return out
  }

  private now = () => this.opts.now?.() ?? new Date()
}

interface AnyPublisher {
  publish(companyId: string, type: never, data: never, opts?: never): Promise<unknown>
}

const hasIntegration = (v: unknown) => typeof v === 'string' && v.trim() !== ''

/**
 * Publisher que, além de publicar, enfileira o envio à UTMify: `sale.recorded` de venda aprovada (ou já criada
 * reembolsada) e `sale.updated` de venda que passou a reembolsada, com `utmify_integration_id` (AC-T113-01/02). Sem o DTO
 * da venda no `sale.recorded`, enfileira a aprovação e o job decide. Falha ao enfileirar só é logada.
 */
export function utmifySalePublisher<P extends AnyPublisher>(
  inner: P,
  deps: { enqueue: UtmifyEnqueue; logger?: Logger },
): P {
  const enqueue = async (companyId: string, saleId: string, status: UtmifySaleStatus) => {
    try {
      await enqueueUtmifySale(deps.enqueue, companyId, saleId, status)
    } catch (err) {
      deps.logger?.warn({ err, saleId, status }, 'falha ao enfileirar o envio da venda à UTMify')
    }
  }
  const publish = async (companyId: string, type: string, data: unknown, opts?: unknown) => {
    const out = await inner.publish(companyId, type as never, data as never, opts as never)
    const d = (data ?? {}) as { sale_id?: unknown; sale?: { status?: unknown; utmify_integration_id?: unknown } }
    const saleId = typeof d.sale_id === 'string' && d.sale_id ? d.sale_id : null
    if (!saleId) return out
    const sale = d.sale
    if (type === 'sale.recorded') {
      if (!sale) await enqueue(companyId, saleId, 'approved')
      else if (hasIntegration(sale.utmify_integration_id) && (sale.status === 'approved' || sale.status === 'refunded'))
        await enqueue(companyId, saleId, sale.status)
    } else if (type === 'sale.updated' && sale?.status === 'refunded' && hasIntegration(sale.utmify_integration_id)) {
      await enqueue(companyId, saleId, 'refunded')
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
