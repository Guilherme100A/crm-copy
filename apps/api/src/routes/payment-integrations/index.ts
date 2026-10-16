// Chaves de pagamento ao lead (SPEC T109; 19-integracoes.md §3.1, §5.2, §6 Pagamentos). Leitura com
// settings.integrations.view; criar/editar/testar com .edit; excluir com .delete. Segredos nunca voltam na resposta.
import { Hono, type Context } from 'hono'
import { PaymentIntegrationsError, PaymentIntegrationsService } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Default: `new PaymentIntegrationsService({ db, cipher: credentialsCipher, env: paymentsEnv, fetch: paymentsFetch })`. */
    paymentIntegrations?: PaymentIntegrationsService
    /** `XPAG_API_URL`, `API_PUBLIC_URL`… dos gateways (default `process.env`, lido a cada chamada). */
    paymentsEnv?: Record<string, string | undefined>
    /** `fetch` das chamadas aos gateways. Default: global. */
    paymentsFetch?: typeof globalThis.fetch
  }
}

/** Monta o serviço (o bloco Pagamento e os webhooks da T111 reaproveitam `deps.paymentIntegrations`). */
export function paymentIntegrationsDefaults(deps: ResolvedDeps): PaymentIntegrationsService {
  deps.paymentIntegrations ??= new PaymentIntegrationsService({
    db: deps.db,
    ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
    ...(deps.paymentsEnv ? { env: deps.paymentsEnv } : {}),
    ...(deps.paymentsFetch ? { fetch: deps.paymentsFetch } : {}),
  })
  return deps.paymentIntegrations
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof PaymentIntegrationsError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT', upstream: 'UPSTREAM_ERROR' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON do corpo; vazio vira `{}`. Nunca ecoa o corpo em erro (pode conter o segredo). */
async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

/** Aceita o envelope do produto de referência `{ payment_integration: {...} }`. */
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'payment_integration' in v && Object.keys(v).length === 1
    ? (v as { payment_integration: unknown }).payment_integration
    : v

const SECRET_FIELDS = new Set(['client_secret'])

export function paymentIntegrationsRoutes(deps: ResolvedDeps) {
  const service = paymentIntegrationsDefaults(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('settings.integrations.view')
  const edit = requirePerm('settings.integrations.edit')
  const del = requirePerm('settings.integrations.delete')
  const actor = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  app.get('/api/payment-integrations', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const gateway = c.req.query('gateway')?.trim()
    return c.json({ items: await domain(() => service.list(companyId, gateway ? { gateway } : {})) }, 200)
  })

  app.post('/api/payment-integrations', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const integration = await domain(async () => service.create(companyId, unwrap(await jsonBody(c)), actor(c)))
    setAudit(c, { action: 'payment_integrations.create', targetType: 'payment_integration', targetId: integration.id, detail: { gateway: integration.gateway, label: integration.label } })
    return c.json({ integration }, 201)
  })

  app.get('/api/payment-integrations/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ integration: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['put', 'patch'] as const) {
    app[method]('/api/payment-integrations/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = unwrap(await jsonBody(c))
      const integration = await domain(() => service.update(companyId, c.req.param('id'), body))
      const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      setAudit(c, {
        action: 'payment_integrations.update',
        targetType: 'payment_integration',
        targetId: integration.id,
        detail: { fields: Object.keys(o).filter((k) => !SECRET_FIELDS.has(k)), secret_changed: Boolean(String(o.client_secret ?? '').trim()) },
      })
      return c.json({ integration }, 200)
    })
  }

  app.delete('/api/payment-integrations/:id', del, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const { deleted } = await domain(() => service.remove(companyId, id))
    setAudit(c, { action: 'payment_integrations.delete', targetType: 'payment_integration', targetId: id, detail: { gateway: deleted.gateway, label: deleted.label } })
    return c.json({ ok: true }, 200)
  })

  app.post('/api/payment-integrations/:id/test-connection', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const result = await domain(() => service.testConnection(companyId, id))
    setAudit(c, { action: 'payment_integrations.test', targetType: 'payment_integration', targetId: id, detail: { ok: result.ok } })
    return c.json(result, 200)
  })

  return app
}
