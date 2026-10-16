// Webhooks de entrada: CRUD e histórico (SPEC T72; 09-webhooks-entrada.md §5, §6). Permissões webhooks.view|edit|delete.
import { Hono, type Context } from 'hono'
import { InboundWebhooksError, InboundWebhooksService, type InboundWebhookJobData } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Default: `new InboundWebhooksService({ db, env: inboundWebhooksEnv, monthlyLimit, maxPerCompany })`. */
    inboundWebhooks?: InboundWebhooksService
    /** `API_PUBLIC_URL` (base da URL pública). Default `process.env`. */
    inboundWebhooksEnv?: Record<string, string | undefined>
    /** Cota mensal de requests aceitos por empresa (default 30 000). */
    inboundWebhooksMonthlyLimit?: number
    /** Webhooks por empresa (default 100). */
    inboundWebhooksMaxPerCompany?: number
    /** Rate limit por token na recepção pública (default 120 por 60 s). */
    inboundWebhookRateLimit?: { limit: number; windowMs: number }
    /** Enfileira o processamento (default: fila BullMQ `inbound-webhooks`). */
    inboundWebhooksEnqueue?: (data: InboundWebhookJobData) => Promise<void>
  }
}

/** Serviço compartilhado pelo CRUD e pela recepção pública (`routes/hooks`). */
export function inboundWebhooksService(deps: ResolvedDeps): InboundWebhooksService {
  deps.inboundWebhooks ??= new InboundWebhooksService({
    db: deps.db,
    ...(deps.inboundWebhooksEnv ? { env: deps.inboundWebhooksEnv } : {}),
    ...(deps.inboundWebhooksMonthlyLimit !== undefined ? { monthlyLimit: deps.inboundWebhooksMonthlyLimit } : {}),
    ...(deps.inboundWebhooksMaxPerCompany !== undefined ? { maxPerCompany: deps.inboundWebhooksMaxPerCompany } : {}),
  })
  return deps.inboundWebhooks
}

export function inboundWebhooksToApi(err: unknown): unknown {
  if (!(err instanceof InboundWebhooksError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', limit: 'LIMIT_REACHED' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw inboundWebhooksToApi(err)
  }
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

/** Aceita o envelope do produto de referência `{ inbound_webhook: {...} }`. */
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'inbound_webhook' in v && Object.keys(v).length === 1 ? (v as { inbound_webhook: unknown }).inbound_webhook : v

export function inboundWebhooksRoutes(deps: ResolvedDeps) {
  const service = inboundWebhooksService(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('webhooks.view')
  const edit = requirePerm('webhooks.edit')
  const del = requirePerm('webhooks.delete')

  app.get('/api/inbound-webhooks', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await domain(() => service.list(companyId)), 200)
  })

  app.post('/api/inbound-webhooks', edit, async (c) => {
    const ctx = getCompanyCtx(c)
    const webhook = await domain(async () => service.create(ctx.companyId, unwrap(await jsonBody(c)), ctx.user?.id ?? null))
    setAudit(c, { action: 'inbound_webhooks.create', targetType: 'inbound_webhook', targetId: webhook.id, detail: { name: webhook.name } })
    return c.json({ webhook }, 201)
  })

  app.get('/api/inbound-webhooks/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ webhook: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['put', 'patch'] as const) {
    app[method]('/api/inbound-webhooks/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = unwrap(await jsonBody(c))
      const webhook = await domain(() => service.update(companyId, c.req.param('id'), body))
      const fields = body && typeof body === 'object' ? Object.keys(body) : []
      setAudit(c, { action: 'inbound_webhooks.update', targetType: 'inbound_webhook', targetId: webhook.id, detail: { fields } })
      return c.json({ webhook }, 200)
    })
  }

  app.delete('/api/inbound-webhooks/:id', del, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const removed = await domain(() => service.remove(companyId, c.req.param('id')))
    setAudit(c, { action: 'inbound_webhooks.delete', targetType: 'inbound_webhook', targetId: removed.id, detail: { name: removed.name } })
    return c.json({ ok: true }, 200)
  })

  app.get('/api/inbound-webhooks/:id/requests', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await domain(() => service.requests(companyId, c.req.param('id'), c.req.query())), 200)
  })

  return app
}
