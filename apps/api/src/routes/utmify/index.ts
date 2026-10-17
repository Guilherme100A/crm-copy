// Integrações UTMify (SPEC T113; 11-facebook-ads.md §3.6, §6 `/utmify_integrations`). CRUD com
// settings.integrations.view|edit|delete; status do envio da venda com dashboard.sales. O token nunca volta na resposta,
// em `details` de erro nem na auditoria (AC-T113-04).
import { Hono, type Context } from 'hono'
import { UtmifyError, UtmifyIntegrationsService, UtmifySendService } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Default: `new UtmifyIntegrationsService({ db, cipher: credentialsCipher, env: utmifyEnv, fetch: utmifyFetch })`. */
    utmifyIntegrations?: UtmifyIntegrationsService
    /** `UTMIFY_API_URL`/`APP_NAME` (default `process.env`, lido a cada chamada). */
    utmifyEnv?: Record<string, string | undefined>
    /** `fetch` das chamadas à UTMify. Default: global. */
    utmifyFetch?: typeof globalThis.fetch
  }
}

/** Monta o serviço de integrações UTMify. */
export function utmifyIntegrationsDefaults(deps: ResolvedDeps): UtmifyIntegrationsService {
  deps.utmifyIntegrations ??= new UtmifyIntegrationsService({
    db: deps.db,
    ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
    ...(deps.utmifyEnv ? { env: deps.utmifyEnv } : {}),
    ...(deps.utmifyFetch ? { fetch: deps.utmifyFetch } : {}),
  })
  return deps.utmifyIntegrations
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof UtmifyError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON do corpo; vazio vira `{}`. Nunca ecoa o corpo em erro (pode conter o token). */
async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

/** Aceita o envelope do produto de referência `{ utmify_integration: {...} }`. */
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'utmify_integration' in v && Object.keys(v).length === 1
    ? (v as { utmify_integration: unknown }).utmify_integration
    : v

const TOKEN_FIELDS = new Set(['integration_token'])
const truthy = (v: string | undefined) => v === '1' || v === 'true'

export function utmifyRoutes(deps: ResolvedDeps) {
  const service = utmifyIntegrationsDefaults(deps)
  const sends = new UtmifySendService({ db: deps.db, integrations: service, logger: deps.logger })
  const app = new Hono<AppEnv>()
  const view = requirePerm('settings.integrations.view')
  const edit = requirePerm('settings.integrations.edit')
  const del = requirePerm('settings.integrations.delete')
  const salesView = requirePerm('dashboard.sales')
  const actor = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  /** `?configured=1`: só as com token (seletor "UTMify" do bloco Venda aprovada, 11 §3.6). */
  app.get('/api/utmify-integrations', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const configured = truthy(c.req.query('configured'))
    return c.json({ utmify_integrations: await domain(() => service.list(companyId, { configured })) }, 200)
  })

  app.post('/api/utmify-integrations', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const integration = await domain(async () => service.create(companyId, unwrap(await jsonBody(c)), actor(c)))
    setAudit(c, {
      action: 'utmify_integrations.create',
      targetType: 'utmify_integration',
      targetId: integration.id,
      detail: { company_name: integration.company_name, token_configured: integration.token_configured },
    })
    return c.json({ utmify_integration: integration }, 201)
  })

  app.get('/api/utmify-integrations/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ utmify_integration: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  /** Fluxos ativos cujo bloco "Venda aprovada" envia por esta integração (aviso antes de excluir). */
  app.get('/api/utmify-integrations/:id/usage', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const usage = await domain(() => service.usage(companyId, c.req.param('id')))
    return c.json({ ...usage, in_use: usage.flows.length > 0 }, 200)
  })

  for (const method of ['put', 'patch'] as const) {
    app[method]('/api/utmify-integrations/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = unwrap(await jsonBody(c))
      const integration = await domain(() => service.update(companyId, c.req.param('id'), body))
      const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      setAudit(c, {
        action: 'utmify_integrations.update',
        targetType: 'utmify_integration',
        targetId: integration.id,
        detail: {
          fields: Object.keys(o).filter((k) => !TOKEN_FIELDS.has(k)),
          token_changed: Boolean(String(o.integration_token ?? '').trim()),
        },
      })
      return c.json({ utmify_integration: integration }, 200)
    })
  }

  /** Em uso por bloco "Venda aprovada" de fluxo ativo: 409 com o aviso e os fluxos; `?force=1` confirma a exclusão. */
  app.delete('/api/utmify-integrations/:id', del, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const result = await domain(() => service.remove(companyId, id, { force: truthy(c.req.query('force')) }))
    setAudit(c, {
      action: 'utmify_integrations.delete',
      targetType: 'utmify_integration',
      targetId: id,
      detail: { company_name: result.deleted.company_name, flows: result.flows.length },
    })
    return c.json({ ok: true, warning: result.warning, flows: result.flows }, 200)
  })

  // ---- Status do envio à UTMify por venda (AC-T113-03). Montadas antes de `salesRoutes`. ----

  /** `?sale_ids=a,b` → envios das vendas da empresa (lista de vendas da UI, T114). */
  app.get('/api/sale-utmify', salesView, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const ids = (c.req.query('sale_ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return c.json({ items: await domain(() => sends.forSales(companyId, ids)) }, 200)
  })

  app.get('/api/sales/:id/utmify', salesView, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ utmify: await domain(() => sends.forSale(companyId, c.req.param('id'))) }, 200)
  })

  return app
}
