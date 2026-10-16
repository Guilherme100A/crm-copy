// Nó Pixel (T104; 06 §3.5; 11 §5.4): `send_pixel_event` manda `Compra` (Purchase) ou `Lead` pela Conversions API.
// - Saídas: `success` (ou `source`, em fluxos antigos sem aresta `success`) e `failure`. Sem aresta `failure`, a falha
//   do tracking só é logada e o fluxo segue — tracking não derruba o atendimento.
// - `item_value` e `currency` aceitam variáveis (`{preco}`); moeda vazia/inválida → BRL; `page_id` é ignorado (campo
//   de WABA, fora da CAPI de site/servidor).
// - Escreve só na transação do passo (`ctx.repo.db`); o POST acontece uma vez por passo (`ctx.once`) com
//   `event_id = ctx.idempotencyKey('pixel')` — o retry do passo não reenvia.
// `registerPixelNodes` troca o stub do grupo `pixel` em `nodes/index.ts`; `configurePixelNodes` define as deps do processo.
import type { Database } from '@crm/db'
import { CapiService, type CapiSendResult, type CapiServiceOptions } from '../../../meta-capi/service'
import type { NodeContext, NodeHandler, NodeOutcome } from '../../engine/context'
import type { NodeRegistry } from '../../engine/registry'

/** Opções do CapiService do nó (o `db` é sempre o do passo). */
export type PixelNodeDeps = Partial<Omit<CapiServiceOptions, 'db'>>

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
        const eventName = c.event_type === 'Lead' ? 'Lead' : 'Purchase'
        const rawValue = c.item_value
        const value = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' ? ctx.render(rawValue) : null
        const currency = typeof c.currency === 'string' ? ctx.render(c.currency) : null
        const capi = new CapiService({ ...deps, db })
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
            db,
          }),
        )
        if (result.status === 'failed') throw new PixelNodeError('capi_failed', result.error)
        ctx.setVar('pixel', { event_id: result.eventId, status: result.status, event: eventName })
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
