// Recepção pública das fontes de venda (SPEC T73): `POST /api/hooks/sales/:token`, sem sessão nem CSRF, no padrão da
// T72. Ordem: rate limit por token → token (404) → corpo (≤ 256 KB, senão 413) → HMAC (401, nada gravado) → JSON
// (400) → grava o evento e responde 202 sem processar inline; o evento vai para a fila `inbound-sales`.
// O token fica no caminho, que o request-logger mascara (`/api/hooks/sales/***`).
import {
  defineQueue,
  DEFAULT_SALE_HOOK_RATE_LIMIT,
  INBOUND_SALE_JOB,
  INBOUND_SALES_QUEUE,
  inboundSaleJobId,
  SALE_HOOK_BODY_LIMIT,
  SALE_SIGNATURE_HEADER,
  SaleSourcesError,
  type InboundSaleJobData,
} from '@crm/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ApiError } from '../../lib/errors'
import { RateLimiter } from '../../lib/rate-limiter'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { saleSourcesService } from '../sale-sources/index'

declare module '../../lib/types' {
  interface AppDeps {
    /** Enfileira o processamento (default: fila BullMQ `inbound-sales` pelo `REDIS_URL`/`CRM_QUEUE_PREFIX`). */
    inboundSalesEnqueue?: (data: InboundSaleJobData, opts: { jobId: string }) => Promise<void>
    /** Rate limit por token (default 120/min). */
    inboundSalesRateLimit?: { limit: number; windowMs: number }
  }
}

export function inboundSalesEnqueuer(deps: ResolvedDeps): (data: InboundSaleJobData, opts: { jobId: string }) => Promise<void> {
  if (deps.inboundSalesEnqueue) return deps.inboundSalesEnqueue
  let queue: ReturnType<typeof defineQueue<InboundSaleJobData>> | undefined
  return async (data, opts) => {
    queue ??= defineQueue<InboundSaleJobData>(INBOUND_SALES_QUEUE)
    await queue.add(INBOUND_SALE_JOB, data, { jobId: opts.jobId })
  }
}

export function hooksSalesRoutes(deps: ResolvedDeps) {
  const service = saleSourcesService(deps)
  const rate = deps.inboundSalesRateLimit ?? DEFAULT_SALE_HOOK_RATE_LIMIT
  const limiter = new RateLimiter({ redis: deps.redis, limit: rate.limit, windowMs: rate.windowMs, prefix: 'crm:rl:sale-hook' })
  const enqueue = inboundSalesEnqueuer(deps)
  const app = new Hono<AppEnv>()

  app.post('/api/hooks/sales/:token', async (c, next) => {
    const token = c.req.param('token')
    const r = await limiter.hit(token)
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))))
      throw new ApiError('RATE_LIMIT', 'Muitas requisições para esta fonte de venda; tente novamente mais tarde')
    }
    const source = await service.findByToken(token)
    if (!source) throw new ApiError('NOT_FOUND', 'Fonte de venda não encontrada')
    c.set('saleSource' as never, source as never)
    return next()
  })

  app.post(
    '/api/hooks/sales/:token',
    bodyLimit({
      maxSize: SALE_HOOK_BODY_LIMIT,
      onError: () => {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Corpo acima de 256 KB')
      },
    }),
    async (c) => {
      const source = c.get('saleSource' as never) as Parameters<typeof service.receive>[0]
      const raw = await c.req.text()
      let job: InboundSaleJobData
      try {
        job = await service.receive(source, raw, c.req.header(SALE_SIGNATURE_HEADER))
      } catch (err) {
        if (!(err instanceof SaleSourcesError)) throw err
        if (err.code === 'invalid_signature') throw new ApiError('UNAUTHORIZED', 'Assinatura inválida')
        throw new ApiError('MALFORMED_REQUEST', err.message)
      }
      try {
        await enqueue(job, { jobId: inboundSaleJobId(job.eventId) })
      } catch (err) {
        // O evento fica `pending` e pode ser reprocessado pelo replay; a origem não deve reenviar.
        c.get('logger')?.warn({ err, event_id: job.eventId }, 'inbound-sales: falha ao enfileirar')
      }
      return c.json({ ok: true, event_id: job.eventId, status: 'pending' }, 202)
    },
  )

  return app
}
