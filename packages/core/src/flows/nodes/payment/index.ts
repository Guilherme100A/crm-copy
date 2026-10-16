// Nó Pagamento (T111; 19 §3.8, §5.5; 06 §3.5): `create_payment_charge` cria a cobrança no gateway da integração
// (T109/T110) e expõe `{gateway.transaction_id|checkout_url|payment_code|qr_url|value|error}`.
// - Saídas: `output:charge_created`, `output:payment_approved` e `failure` (o "Erro" do produto).
// - Com aresta `charge_created`: segue o ramo (ex.: mandar o PIX); a confirmação dentro do `listener_ttl` "interrompe o
//   contato" e leva o run ao `payment_approved` (`FlowControl.interruptForPayment`, pelo webhook).
// - Sem essa aresta: o run espera no nó (`wait.kind = 'payment'`) até o webhook (`resolvePayment`) ou o fim do TTL.
// - Valor com vírgula/ponto e variáveis; "chave sem valor" (`open_amount`) cria sem valor e usa o pago no webhook.
// - Grava só pela transação do passo (`ctx.repo.db`); a cobrança acontece uma vez por passo (`ctx.once`).
import { and, eq } from 'drizzle-orm'
import { flowNodes, paymentCharges, type Database } from '@crm/db'
import { handle, PAYMENT_OUTPUTS } from '@crm/shared'
import { parseMoney } from '../../../meta-capi/hashing'
import { PaymentIntegrationsService } from '../../../payments/keys/service'
import { PaymentGatewayError, type ChargeRequest, type ChargeResult, type PaymentGateway } from '../../../payments/port'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import type { NodeRegistry } from '../../engine/registry'
import { MAX_WAIT_MS, waitForPayment } from '../../engine/waits'

export const PAYMENT_HANDLES = {
  chargeCreated: handle.output(PAYMENT_OUTPUTS.chargeCreated),
  paymentApproved: handle.output(PAYMENT_OUTPUTS.paymentApproved),
  failure: handle.failure,
} as const

/** Escuta padrão da confirmação: 2 dias (19 §3.8). */
export const DEFAULT_LISTENER_TTL_MS = 2 * 86_400_000
const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 }

export interface PaymentNodeDeps {
  /** Integrações de pagamento (adapter com credenciais decifradas). Default: `PaymentIntegrationsService` na transação do passo. */
  paymentIntegrations?: Pick<PaymentIntegrationsService, 'gatewayFor'>
  /** Relógio do `listener_until` (use o mesmo do motor/controle nos testes). */
  now?: () => Date
}

export class PaymentNodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PaymentNodeError'
  }
}

let processDeps: PaymentNodeDeps = {}

/** Deps do registry padrão do processo. */
export function configurePaymentNodes(deps: PaymentNodeDeps): void {
  processDeps = { ...processDeps, ...deps }
}

type Config = Record<string, unknown>
const configOf = (ctx: NodeContext): Config =>
  ([...ctx.node.actions].filter((a) => a.type === 'create_payment_charge').sort((a, b) => a.order - b.order)[0]?.config ?? {}) as Config
const hasEdge = (ctx: NodeContext, h: string) => ctx.definition.edges.some((e) => e.from === ctx.node.id && e.handle === h)
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** "100,00" | "1.299,90" | 49.9 | "{preco}" já renderizado → centavos; vazio/inválido → null. */
export function amountToCents(value: unknown): number | null {
  const n = parseMoney(typeof value === 'number' ? value : str(value))
  return n !== null && n > 0 ? Math.round(n * 100) : null
}

/** TTL da escuta em ms (padrão 2 dias; teto de 31 dias). */
export function listenerTtlMs(value: unknown, unit: unknown): number {
  const v = typeof value === 'number' && value > 0 ? value : null
  const u = typeof unit === 'string' && UNIT_MS[unit] ? UNIT_MS[unit]! : null
  if (v === null || u === null) return DEFAULT_LISTENER_TTL_MS
  return Math.min(v * u, MAX_WAIT_MS)
}

/** `{gateway.value}`: decimal com ponto e 2 casas ("123.45"). */
export const paymentValueOf = (cents: number | null | undefined) => (typeof cents === 'number' ? (cents / 100).toFixed(2) : '')

export function paymentHandler(deps: PaymentNodeDeps = {}): NodeHandler {
  return {
    async execute(ctx): Promise<NodeOutcome> {
      const c = configOf(ctx)
      const db = ctx.repo.db as Database | null
      if (ctx.repo.dryRun || !db) return { next: PAYMENT_HANDLES.chargeCreated }
      const now = deps.now?.() ?? new Date()
      const fail = (err: unknown): NodeOutcome => {
        const e = err instanceof PaymentGatewayError ? err : null
        const message = err instanceof Error ? err.message : String(err)
        ctx.setVar('gateway', { ...asObj(ctx.vars.gateway), error: message, error_code: e?.code ?? (err instanceof PaymentNodeError ? err.code : 'generic'), status: 'error' })
        // Sem a saída "Erro": o run falha com a mensagem (padrão do motor).
        if (!hasEdge(ctx, PAYMENT_HANDLES.failure)) throw err instanceof Error ? err : new Error(message)
        return { next: PAYMENT_HANDLES.failure }
      }
      try {
        const gatewayId = str(c.gateway).trim()
        const integrationId = str(c.payment_integration_id).trim()
        if (!integrationId) throw new PaymentNodeError('integration_missing', 'selecione a integração de pagamento')
        const integrations = deps.paymentIntegrations ?? new PaymentIntegrationsService({ db })
        let gateway: PaymentGateway
        try {
          gateway = await integrations.gatewayFor(ctx.companyId, integrationId)
        } catch {
          throw new PaymentNodeError('integration_not_found', 'integração de pagamento não encontrada')
        }
        if (gatewayId && gateway.id !== gatewayId) throw new PaymentNodeError('gateway_mismatch', `a integração é do gateway ${gateway.id}`)
        const open = c.open_amount === true
        const amountCents = open ? null : amountToCents(ctx.render(str(c.amount)))
        if (!open && amountCents === null) throw new PaymentGatewayError('validation', 'valor inválido', { fields: [{ path: 'amount', message: 'valor inválido' }] })
        // Defaults do bloco (19 §3.8): nome `{full_name}`, telefone `{phone_number}`.
        const DEFAULTS: Record<string, string> = { name: '{full_name}', phone: '{phone_number}' }
        const render = (k: string) => {
          const v = ctx.render(c[k] === undefined ? (DEFAULTS[k] ?? '') : str(c[k])).trim()
          return v || undefined
        }
        const req: ChargeRequest = {
          currency: (str(c.currency).trim() || 'BRL').toUpperCase(),
          method: str(c.method).trim().toUpperCase() || 'PIX',
          amount_cents: amountCents,
          name: render('name'),
          email: render('email'),
          phone: render('phone'),
          document: render('document'),
          document_type: render('document_type'),
          external_id: ctx.idempotencyKey('payment_charge').slice(0, 40),
        }
        const listenerUntil = new Date(now.getTime() + listenerTtlMs(c.listener_ttl_value, c.listener_ttl_unit))
        const created = await ctx.once('payment_charge', async () => {
          const charge: ChargeResult = await gateway.createCharge(req)
          const [node] = await db.select({ id: flowNodes.id }).from(flowNodes).where(and(eq(flowNodes.flowId, ctx.flowId), eq(flowNodes.key, ctx.node.id))).limit(1)
          const instructions = {
            ...(charge.checkout_url ? { checkout_url: charge.checkout_url } : {}),
            ...(charge.payment_code ? { payment_code: charge.payment_code } : {}),
            ...(charge.qr_image_url ? { qr_url: charge.qr_image_url } : {}),
            ...(charge.bank_info ? { bank_info: charge.bank_info } : {}),
            ...(charge.expires_at ? { expires_at: charge.expires_at } : {}),
            listener: { node_key: ctx.node.id, run_id: ctx.runId },
          }
          const [row] = await db
            .insert(paymentCharges)
            .values({
              companyId: ctx.companyId,
              integrationId,
              gateway: gateway.id as never,
              flowRunId: ctx.runId,
              nodeId: node?.id ?? null,
              contactId: ctx.contactId,
              amountCents,
              currency: req.currency,
              method: req.method,
              transactionId: charge.transaction_id,
              status: 'created',
              listenerUntil,
              instructions,
            })
            .onConflictDoNothing({ target: [paymentCharges.gateway, paymentCharges.transactionId] })
            .returning({ id: paymentCharges.id })
          return { chargeId: row?.id ?? null, charge }
        })
        const { charge } = created
        ctx.setVar('gateway', {
          transaction_id: charge.transaction_id,
          checkout_url: charge.checkout_url ?? '',
          payment_code: charge.payment_code ?? '',
          qr_url: charge.qr_image_url ?? '',
          bank_name: charge.bank_info?.bank_name ?? '',
          beneficiary: charge.bank_info?.beneficiary ?? '',
          reference: charge.bank_info?.reference ?? '',
          value: open ? '' : paymentValueOf(amountCents),
          error: '',
          status: 'created',
          charge_id: created.chargeId,
          listener_until: listenerUntil.toISOString(),
        })
        if (hasEdge(ctx, PAYMENT_HANDLES.chargeCreated) || !created.chargeId) return { next: PAYMENT_HANDLES.chargeCreated }
        return { wait: waitForPayment({ chargeId: created.chargeId, transactionId: charge.transaction_id, deadlineAt: listenerUntil, approved: PAYMENT_HANDLES.paymentApproved, now: () => now }) }
      } catch (err) {
        return fail(err)
      }
    },
  }
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

export function registerPaymentNodes(registry: NodeRegistry, deps?: PaymentNodeDeps): NodeRegistry {
  registry.register('payment', deps ? paymentHandler(deps) : { execute: (ctx) => paymentHandler(processDeps).execute(ctx) })
  return registry
}
