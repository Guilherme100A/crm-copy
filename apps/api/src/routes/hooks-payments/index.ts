// Webhooks públicos dos gateways de pagamento (SPEC T111; 19 §5.5): `POST /api/hooks/payments/:gateway/:integrationId`
// — a URL que a T109 entrega ao gateway (`webhook_url`), com o token da integração na query (`?token=`).
// - Gateway/integração inexistente, de outro gateway ou sem adapter → 404 (o "token inválido" do AC-T111-04: o
//   endpoint não existe para esse par).
// - Token ausente/errado → 401 (`parseWebhook` → `invalid_signature`); nada é enfileirado.
// - OK → 202 `{ accepted }` e 1 job `payment-webhooks` por evento (dedupe por jobId).
// O token só vem na query, que o request-logger não grava (só `c.req.path`); aqui ele vira o header
// `x-webhook-token` para o adapter (comparação em tempo constante lá).
import { defineQueue, PAYMENT_WEBHOOKS_QUEUE, paymentWebhookJobId, PaymentWebhookError, PaymentWebhookService, XPAG_WEBHOOK_TOKEN_HEADER, type PaymentWebhookJobData } from '@crm/core'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { paymentIntegrationsDefaults } from '../payment-integrations/index'

declare module '../../lib/types' {
  interface AppDeps {
    /** Enfileira o processamento (default: fila BullMQ `payment-webhooks` pelo `REDIS_URL`/`CRM_QUEUE_PREFIX`). */
    paymentWebhookEnqueue?: (data: PaymentWebhookJobData, opts: { jobId: string }) => Promise<void>
  }
}

export const PAYMENT_WEBHOOK_JOB_OPTS = { attempts: 8, backoff: { type: 'exponential', delay: 5_000 } } as const
const MAX_BODY_BYTES = 256 * 1024

export function hooksPaymentsRoutes(deps: ResolvedDeps) {
  let queue: ReturnType<typeof defineQueue<PaymentWebhookJobData>> | undefined
  let service: PaymentWebhookService | undefined
  const svc = () => (service ??= new PaymentWebhookService({ db: deps.db, integrations: paymentIntegrationsDefaults(deps), ...(deps.logger ? { logger: deps.logger } : {}) }))
  const enqueue =
    deps.paymentWebhookEnqueue ??
    (async (data: PaymentWebhookJobData, opts: { jobId: string }) => {
      queue ??= defineQueue<PaymentWebhookJobData>(PAYMENT_WEBHOOKS_QUEUE, { defaultJobOptions: PAYMENT_WEBHOOK_JOB_OPTS })
      await queue.add(PAYMENT_WEBHOOKS_QUEUE, data, { jobId: opts.jobId })
    })
  const app = new Hono<AppEnv>()

  app.post(
    '/api/hooks/payments/:gateway/:integrationId',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError('PAYLOAD_TOO_LARGE', 'Webhook acima de 256 KB')
      },
    }),
    async (c) => {
      const rawBody = await c.req.text()
      const headers: Record<string, string> = {}
      c.req.raw.headers.forEach((v, k) => (headers[k] = v))
      const token = c.req.query('token')
      if (token !== undefined) headers[XPAG_WEBHOOK_TOKEN_HEADER] = token
      let received: Awaited<ReturnType<PaymentWebhookService['receive']>>
      try {
        received = await svc().receive({ gateway: c.req.param('gateway'), integrationId: c.req.param('integrationId'), rawBody, headers })
      } catch (err) {
        if (!(err instanceof PaymentWebhookError)) throw err
        if (err.code === 'not_found') throw new ApiError('NOT_FOUND', 'Webhook não encontrado')
        if (err.code === 'invalid_signature') throw new ApiError('UNAUTHORIZED', 'Assinatura do webhook inválida')
        throw new ApiError('MALFORMED_REQUEST', err.message)
      }
      for (const event of received.events) {
        await enqueue({ companyId: received.companyId, integrationId: received.integrationId, gateway: received.gateway, event }, { jobId: paymentWebhookJobId(received.gateway, event) })
      }
      return c.json({ accepted: received.events.length }, 202)
    },
  )

  return app
}
