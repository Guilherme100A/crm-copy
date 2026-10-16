// Recepção pública dos webhooks de entrada (SPEC T72): `POST /api/hooks/in/:token`, sem sessão nem CSRF.
// Ordem: rate limit por token → token (404) → corpo (≤ 256 KB guardados; acima trunca com a flag) → grava e responde
// 202 sem processar inline; o request aceito vai para a fila `inbound-webhooks` (processador da T81).
import { Hono } from 'hono'
import {
  defineQueue,
  DEFAULT_INBOUND_WEBHOOK_RATE_LIMIT,
  INBOUND_WEBHOOK_JOB,
  INBOUND_WEBHOOKS_QUEUE,
  inboundWebhookJobId,
  readInboundBody,
  type InboundWebhookJobData,
} from '@crm/core'
import { ApiError } from '../../lib/errors'
import { RateLimiter } from '../../lib/rate-limiter'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { inboundWebhooksService } from '../inbound-webhooks/index'

export function hooksRoutes(deps: ResolvedDeps) {
  const service = inboundWebhooksService(deps)
  const rate = deps.inboundWebhookRateLimit ?? DEFAULT_INBOUND_WEBHOOK_RATE_LIMIT
  const limiter = new RateLimiter({ redis: deps.redis, limit: rate.limit, windowMs: rate.windowMs, prefix: 'crm:rl:inbound-webhook' })
  let queue: ReturnType<typeof defineQueue<InboundWebhookJobData>> | undefined
  const enqueue =
    deps.inboundWebhooksEnqueue ??
    (async (data: InboundWebhookJobData) => {
      queue ??= defineQueue<InboundWebhookJobData>(INBOUND_WEBHOOKS_QUEUE)
      await queue.add(INBOUND_WEBHOOK_JOB, data, { jobId: inboundWebhookJobId(data.requestId) })
    })

  const app = new Hono<AppEnv>()

  app.post('/api/hooks/in/:token', async (c) => {
    const token = c.req.param('token')
    const r = await limiter.hit(token)
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))))
      throw new ApiError('RATE_LIMIT', 'Muitas requisições para este webhook; tente novamente mais tarde')
    }
    const webhook = await service.findByToken(token)
    if (!webhook) throw new ApiError('NOT_FOUND', 'Webhook não encontrado')
    const body = await readInboundBody(c.req.raw.body, { contentType: c.req.header('content-type') ?? null })
    const result = await service.receive(webhook, body)
    if (result.outcome === 'not_found') throw new ApiError('NOT_FOUND', 'Webhook não encontrado')
    if (result.outcome === 'quota') throw new ApiError('QUOTA_EXCEEDED', 'Cota mensal de webhooks da empresa esgotada', { request_id: result.requestId })
    if (result.outcome === 'accepted') {
      try {
        await enqueue({ requestId: result.requestId, webhookId: result.webhookId, companyId: result.companyId })
      } catch (err) {
        // O request fica `pending` no banco; o processador pode varrê-lo depois. A origem não deve reenviar.
        c.get('logger')?.warn({ err, request_id: result.requestId }, 'inbound-webhooks: falha ao enfileirar')
      }
    }
    return c.json({ ok: true, request_id: result.requestId, status: result.outcome === 'accepted' ? 'pending' : 'skipped' }, 202)
  })

  return app
}
