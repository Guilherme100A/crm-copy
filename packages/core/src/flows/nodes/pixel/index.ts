// Nó Pixel (T104; 06 §3.5; 11 §5.4): `send_pixel_event` manda `Compra` (Purchase), `Lead` e (revisão 3) os eventos
// padrão InitiateCheckout, AddToCart, CompleteRegistration, Contact, Schedule e Subscribe pela Conversions API. O modo
// (chat ou business_messaging, com fallback) é decidido pelo CapiService a partir do pixel e do contato.
// - Saídas: `success` (ou `source`, em fluxos antigos sem aresta `success`) e `failure`. Sem aresta `failure`, a falha
//   do tracking só é logada e o fluxo segue — tracking não derruba o atendimento.
// - `item_value` e `currency` aceitam variáveis (`{preco}`); moeda vazia/inválida → BRL; `page_id`/`whatsapp_business_account_id` do nó (opcionais,
//   aceitam variável) sobrepõem os do pixel no modo business_messaging (revisão 3; paridade Leona 11 §5.4).
// - Escreve só na transação do passo (`ctx.repo.db`); o POST acontece uma vez por passo (`ctx.once`) com
//   `event_id = ctx.idempotencyKey('pixel')` — o retry do passo não reenvia.
// `registerPixelNodes` troca o stub do grupo `pixel` em `nodes/index.ts`; `configurePixelNodes` define as deps do processo.
import type { Database } from '@crm/db'
import { eventJobId, type CapiEventEnqueue } from '../../../meta-capi/ad-lead'
import { CAPI_EVENT_NAMES, CapiService, type CapiEventName, type CapiSendResult, type CapiServiceOptions } from '../../../meta-capi/service'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import type { NodeRegistry } from '../../engine/registry'

/** Opções do CapiService do nó (o `db` é sempre o do passo). */
export type PixelNodeDeps = Partial<Omit<CapiServiceOptions, 'db'>> & {
  /** Fila da retentativa de evento incerto (job `meta-capi` `event`). */
  enqueueRetry?: CapiEventEnqueue
}

export class PixelNodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PixelNodeError'
  }
}

let processDeps: PixelNodeDeps = {}

/** Deps do registry padrão do processo (ex.: `fetch`/`graphUrl` de teste, `testEventCode`). */
export function configurePixelNodes(deps: PixelNodeDeps): void {
  processDeps = { ...processDeps, ...deps }
}

type Config = Record<string, unknown>
const configOf = (ctx: NodeContext): Config =>
  ([...ctx.node.actions].filter((a) => a.type === 'send_pixel_event').sort((a, b) => a.order - b.order)[0]?.config ?? {}) as Config

const hasEdge = (ctx: NodeContext, handle: string) => ctx.definition.edges.some((e) => e.from === ctx.node.id && e.handle === handle)

/** `event_type` do nó → nome do evento da Meta (`Compra` = Purchase; desconhecido → Purchase, como antes). */
export function pixelEventName(type: unknown): CapiEventName {
  if (type === 'Compra') return 'Purchase'
  return (CAPI_EVENT_NAMES as readonly unknown[]).includes(type) ? (type as CapiEventName) : 'Purchase'
}

export function pixelHandler(deps: PixelNodeDeps = {}): NodeHandler {
  return {
    async execute(ctx): Promise<NodeOutcome> {
      const ok: NodeOutcome = { next: hasEdge(ctx, 'success') ? 'success' : 'source' }
      const db = ctx.repo.db as Database | null
      if (ctx.repo.dryRun || !db) return ok
      try {
        const c = configOf(ctx)
        const pixelConfigId = String(c.pixel_config_id ?? '').trim()
        if (!pixelConfigId) throw new PixelNodeError('pixel_not_configured', 'selecione o pixel')
        const eventName = pixelEventName(c.event_type)
        const rawValue = c.item_value
        const value = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' ? ctx.render(rawValue) : null
        const currency = typeof c.currency === 'string' ? ctx.render(c.currency) : null
        const digits = (v: unknown) => (typeof v === 'string' ? ctx.render(v).replace(/\D/g, '') : '') || null
        const pageId = digits(c.page_id)
        const wabaId = digits(c.whatsapp_business_account_id)
        const { enqueueRetry, ...capiOpts } = deps
        const capi = new CapiService({ ...capiOpts, db })
        const result = await ctx.once<CapiSendResult>('pixel', async () =>
          capi.send({
            companyId: ctx.companyId,
            pixelConfigId,
            eventName,
            eventId: ctx.idempotencyKey('pixel'),
            value,
            currency,
            user: await capi.userFromContact(ctx.companyId, ctx.contactId, db),
            actionSource: 'chat',
            source: 'flow',
            sourceId: ctx.runId,
            pageId,
            wabaId,
            db,
          }),
        )
        if (result.status === 'failed') throw new PixelNodeError('capi_failed', result.error)
        // Timeout/rede/5xx: a Meta pode ter recebido. Retenta o MESMO evento pela fila (mesmo event_id e modo); sem fila,
        // vira falha do nó.
        if (result.status === 'uncertain') {
          if (!enqueueRetry) throw new PixelNodeError('capi_uncertain', result.error)
          await enqueueRetry(
            { kind: 'event', companyId: ctx.companyId, pixelConfigId, eventName, eventId: result.eventId, value, currency, contactId: ctx.contactId ?? null, actionSource: 'chat', source: 'flow', sourceId: ctx.runId, pageId, wabaId },
            { jobId: eventJobId(pixelConfigId, result.eventId) },
          )
        }
        ctx.setVar('pixel', { event_id: result.eventId, status: result.status, event: eventName, ...(result.status === 'sent' ? { mode: result.mode } : {}) })
        return ok
      } catch (err) {
        if (hasEdge(ctx, 'failure')) throw err
        ctx.log.warn({ err, nodeId: ctx.node.id }, 'evento de pixel não enviado; seguindo o fluxo')
        return ok
      }
    },
  }
}

export function registerPixelNodes(registry: NodeRegistry, deps?: PixelNodeDeps): NodeRegistry {
  registry.register('pixel', deps ? pixelHandler(deps) : { execute: (ctx) => pixelHandler(processDeps).execute(ctx) })
  return registry
}
