// Escuta de amostra do webhook de entrada (SPEC T81; 09 §2, §4, §7): `POST /api/inbound-webhooks/:id/sample-listen`
// registra o usuário como ouvinte por 90 s; o processador (worker) publica `webhook.sample_received` só no stream
// desse usuário e encerra a escuta. `DELETE` cancela. Permissão `webhooks.view`; webhook de outra empresa → 404.
import { SampleListeners } from '@crm/core'
import { inboundWebhooks } from '@crm/db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function inboundWebhookSamplesRoutes(deps: ResolvedDeps) {
  const listeners = () => new SampleListeners(deps.redis as never)
  const app = new Hono<AppEnv>()
  const view = requirePerm('webhooks.view')

  const webhookOf = async (companyId: string, id: string) => {
    if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Webhook não encontrado')
    const [w] = await deps.db
      .select({ id: inboundWebhooks.id })
      .from(inboundWebhooks)
      .where(and(eq(inboundWebhooks.companyId, companyId), eq(inboundWebhooks.id, id)))
      .limit(1)
    if (!w) throw new ApiError('NOT_FOUND', 'Webhook não encontrado')
    return w.id
  }

  app.post('/api/inbound-webhooks/:id/sample-listen', view, async (c) => {
    const ctx = getCompanyCtx(c)
    const id = await webhookOf(ctx.companyId, c.req.param('id'))
    if (!ctx.user?.id) throw new ApiError('UNAUTHORIZED', 'Sessão obrigatória')
    const expires = await listeners().listen(id, ctx.user.id)
    return c.json({ listening: true, webhook_id: id, expires_at: expires.toISOString() }, 200)
  })

  app.delete('/api/inbound-webhooks/:id/sample-listen', view, async (c) => {
    const ctx = getCompanyCtx(c)
    const id = await webhookOf(ctx.companyId, c.req.param('id'))
    if (ctx.user?.id) await listeners().stop(id, ctx.user.id)
    return c.json({ listening: false, webhook_id: id }, 200)
  })

  return app
}
