// Webhooks de pagamento (T111; 19 §5.5): a API autentica e converte (`receive` → `parseWebhook` do adapter da
// integração) e enfileira 1 job `payment-webhooks` por evento; o job (`process`) atualiza `payment_charges` e, se o
// pagamento foi aprovado DENTRO do `listener_ttl`, retoma o run do bloco Pagamento pela saída `payment_approved`
// (`resolvePayment` quando o run espera no nó; senão `interruptForPayment`, que "interrompe o contato").
// Idempotente: a cobrança fica travada durante a retomada e marca `instructions.listener.resumed`; um webhook
// repetido (ou depois do TTL) só atualiza a cobrança.
import { and, eq } from 'drizzle-orm'
import { paymentCharges, paymentIntegrations, type Database, type PaymentChargeStatus } from '@crm/db'
import type { AdvanceResult, FlowControl } from '../../flows/engine/control'
import { paymentValueOf, PAYMENT_HANDLES } from '../../flows/nodes/payment/index'
import { PaymentIntegrationsService } from '../keys/service'
import { PaymentGatewayError, type PaymentEvent, type PaymentEventType, type WebhookHeaders } from '../port'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PAYMENT_WEBHOOKS_QUEUE = 'payment-webhooks'

export interface PaymentWebhookJobData {
  companyId: string
  integrationId: string
  gateway: string
  event: PaymentEvent
}

/** jobId do evento (dedupe na fila): `<gateway>:<transaction_id>:<tipo>` (o BullMQ recusa `:` só no prefixo). */
export const paymentWebhookJobId = (gateway: string, ev: Pick<PaymentEvent, 'transaction_id' | 'type'>) => `${gateway}-${ev.transaction_id}-${ev.type}`.replace(/[^\w.-]/g, '_')

export class PaymentWebhookError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_signature' | 'malformed',
    message: string,
  ) {
    super(message)
    this.name = 'PaymentWebhookError'
  }
}

export type PaymentWebhookOutcome =
  | { status: 'ignored'; reason: 'unknown_charge' }
  | { status: 'updated'; charge_status: PaymentChargeStatus; reason?: 'listener_expired' | 'no_listener' | 'not_approved' }
  | { status: 'duplicate'; charge_status: PaymentChargeStatus }
  | { status: 'resumed'; handle: string; via: 'resolvePayment' | 'interruptForPayment' }
  | { status: 'not_resumed'; reason: string }

export interface PaymentWebhookServiceOptions {
  db: Database
  /** Retomada do run (o mesmo `FlowControl` do processo). Sem ele, só atualiza a cobrança. */
  control?: Pick<FlowControl, 'resolvePayment' | 'interruptForPayment'>
  /** Adapter com credenciais da integração. Default `PaymentIntegrationsService({ db })`. */
  integrations?: Pick<PaymentIntegrationsService, 'gatewayFor'>
  /** Relógio que decide "dentro do TTL". */
  now?: () => Date
  logger?: { warn(obj: object, msg?: string): void }
}

const STATUS_OF: Record<PaymentEventType, PaymentChargeStatus> = {
  'payment.approved': 'approved',
  'payment.failed': 'failed',
  'payment.expired': 'expired',
  'payment.refunded': 'refunded',
}

interface ListenerInfo {
  node_key?: string
  run_id?: string
  resumed?: boolean
  resumed_at?: string
  skipped?: string
}

export class PaymentWebhookService {
  constructor(private readonly opts: PaymentWebhookServiceOptions) {}

  private now() {
    return this.opts.now?.() ?? new Date()
  }

  /**
   * Autentica e converte o webhook de UMA integração. Integração inexistente, de outro gateway ou sem adapter →
   * `not_found` (404); token/assinatura inválidos → `invalid_signature` (401), nenhum evento.
   */
  async receive(input: { gateway: string; integrationId: string; rawBody: string | Uint8Array; headers: WebhookHeaders }): Promise<{ companyId: string; integrationId: string; gateway: string; events: PaymentEvent[] }> {
    if (!UUID_RE.test(input.integrationId)) throw new PaymentWebhookError('not_found', 'Integração não encontrada')
    const [row] = await this.opts.db
      .select({ id: paymentIntegrations.id, companyId: paymentIntegrations.companyId, gateway: paymentIntegrations.gateway })
      .from(paymentIntegrations)
      .where(eq(paymentIntegrations.id, input.integrationId))
      .limit(1)
    if (!row || row.gateway !== input.gateway) throw new PaymentWebhookError('not_found', 'Integração não encontrada')
    let gateway
    try {
      gateway = await (this.opts.integrations ?? new PaymentIntegrationsService({ db: this.opts.db })).gatewayFor(row.companyId, row.id)
    } catch {
      throw new PaymentWebhookError('not_found', 'Integração não encontrada')
    }
    try {
      return { companyId: row.companyId, integrationId: row.id, gateway: row.gateway, events: gateway.parseWebhook(input.rawBody, input.headers) }
    } catch (err) {
      if (err instanceof PaymentGatewayError && err.code === 'invalid_signature') throw new PaymentWebhookError('invalid_signature', 'Assinatura do webhook inválida')
      if (err instanceof PaymentGatewayError) throw new PaymentWebhookError('malformed', err.message)
      throw err
    }
  }

  /** Job: aplica UM evento na cobrança e retoma o run se for aprovação dentro do TTL. */
  async process(data: PaymentWebhookJobData): Promise<PaymentWebhookOutcome> {
    const target = STATUS_OF[data.event.type]
    if (!target) return { status: 'ignored', reason: 'unknown_charge' }
    return this.opts.db.transaction(async (tx) => {
      // Trava a cobrança: duas entregas simultâneas do mesmo webhook ficam em fila aqui (só uma retoma).
      const [charge] = await tx
        .select()
        .from(paymentCharges)
        .where(and(eq(paymentCharges.companyId, data.companyId), eq(paymentCharges.gateway, data.gateway as never), eq(paymentCharges.transactionId, data.event.transaction_id)))
        .for('update')
        .limit(1)
      if (!charge) return { status: 'ignored', reason: 'unknown_charge' } as const
      const now = this.now()
      const instructions = { ...(charge.instructions ?? {}) } as Record<string, unknown>
      const listener = { ...((instructions.listener ?? {}) as ListenerInfo) }

      // Não "desaprova": falha/expiração depois de aprovado não muda o status (estorno muda).
      const keepApproved = charge.status === 'approved' && (target === 'failed' || target === 'expired')
      const paidCents = data.event.amount_cents ?? charge.paidAmountCents ?? charge.amountCents
      if (charge.status !== target && !keepApproved) {
        await tx
          .update(paymentCharges)
          .set({
            status: target,
            ...(target === 'approved' ? { paidAmountCents: paidCents && paidCents > 0 ? paidCents : null, paidAt: data.event.paid_at ? new Date(data.event.paid_at) : now } : {}),
            updatedAt: now,
          })
          .where(eq(paymentCharges.id, charge.id))
      } else if (target !== 'approved' || listener.resumed || listener.skipped) {
        return { status: 'duplicate', charge_status: charge.status } as const
      }
      if (target !== 'approved') return { status: 'updated', charge_status: keepApproved ? charge.status : target, reason: 'not_approved' } as const
      if (!charge.flowRunId || !listener.node_key || !this.opts.control) return { status: 'updated', charge_status: 'approved', reason: 'no_listener' } as const
      if (!charge.listenerUntil || now.getTime() > charge.listenerUntil.getTime()) return { status: 'updated', charge_status: 'approved', reason: 'listener_expired' } as const

      const paidAt = (data.event.paid_at ? new Date(data.event.paid_at) : now).toISOString()
      const vars = (current: Record<string, unknown>) => ({
        ...current,
        gateway: {
          ...(current.gateway && typeof current.gateway === 'object' ? (current.gateway as Record<string, unknown>) : {}),
          transaction_id: charge.transactionId,
          value: paymentValueOf(paidCents),
          value_cents: paidCents ?? null,
          status: 'approved',
          paid_at: paidAt,
          error: '',
        },
      })
      const input = { chargeId: charge.id, vars }
      let via: 'resolvePayment' | 'interruptForPayment' = 'resolvePayment'
      let r: AdvanceResult = await this.opts.control.resolvePayment(charge.flowRunId, input)
      if (!r.advanced && (r.reason === 'not_payment' || r.reason === 'not_waiting' || r.reason === 'stale')) {
        via = 'interruptForPayment'
        r = await this.opts.control.interruptForPayment(charge.flowRunId, { ...input, nodeKey: listener.node_key, handle: PAYMENT_HANDLES.paymentApproved })
      }
      // Passo do run em execução: desfaz e o BullMQ tenta de novo.
      if (!r.advanced && r.reason === 'busy') throw new Error('payment-webhooks: run em execução; tentar de novo')
      instructions.listener = r.advanced ? { ...listener, resumed: true, resumed_at: now.toISOString() } : { ...listener, skipped: r.reason }
      await tx.update(paymentCharges).set({ instructions, updatedAt: now }).where(eq(paymentCharges.id, charge.id))
      if (!r.advanced) {
        this.opts.logger?.warn({ chargeId: charge.id, runId: charge.flowRunId, reason: r.reason }, 'pagamento aprovado sem retomar o run')
        return { status: 'not_resumed', reason: r.reason } as const
      }
      return { status: 'resumed', handle: r.handle, via } as const
    })
  }
}
