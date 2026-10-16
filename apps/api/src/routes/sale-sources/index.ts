// Fontes de venda (SPEC T73): CRUD, teste do mapeamento (dry-run), eventos, replay e rotação do token. Permissões
// `settings.integrations.view|edit|delete` (as das integrações, T109). Também `GET /api/contacts/:id/attribution`
// (primeiro e último toque do contato; `contacts.view`).
import { AttributionService, SaleSourcesError, SaleSourcesService } from '@crm/core'
import { Hono, type Context } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { inboundSalesEnqueuer } from '../hooks-sales/index'

declare module '../../lib/types' {
  interface AppDeps {
    /** `API_PUBLIC_URL` das fontes de venda (default `process.env`). */
    saleSourcesEnv?: Record<string, string | undefined>
  }
}

const services = new WeakMap<ResolvedDeps, SaleSourcesService>()

export function saleSourcesService(deps: ResolvedDeps): SaleSourcesService {
  let svc = services.get(deps)
  if (!svc) {
    svc = new SaleSourcesService({
      db: deps.db,
      ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
      ...(deps.saleSourcesEnv ? { env: deps.saleSourcesEnv } : {}),
    })
    services.set(deps, svc)
  }
  return svc
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof SaleSourcesError)) throw err
    if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
    throw new ApiError('VALIDATION_ERROR', err.message, err.details)
  }
}

/** Corpo plano ou envelopado em `{ sale_source: {...} }`. */
async function body(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
  return json && typeof json === 'object' && !Array.isArray(json) && 'sale_source' in json ? (json as { sale_source: unknown }).sale_source : json
}

export function saleSourcesRoutes(deps: ResolvedDeps) {
  const svc = () => saleSourcesService(deps)
  const enqueue = inboundSalesEnqueuer(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('settings.integrations.view')
  const edit = requirePerm('settings.integrations.edit')
  const del = requirePerm('settings.integrations.delete')

  app.get('/api/sale-sources', view, async (c) => c.json({ items: await svc().list(getCompanyCtx(c).companyId) }, 200))

  app.post('/api/sale-sources', edit, async (c) => {
    const ctx = getCompanyCtx(c)
    const sale_source = await domain(async () => svc().create(ctx.companyId, await body(c), ctx.user?.id ?? null))
    setAudit(c, { action: 'sale_sources.create', targetType: 'sale_source', targetId: sale_source.id })
    return c.json({ sale_source }, 201)
  })

  // Teste sem fonte salva (mapeamento no corpo). Antes de `/:id` para não casar como id.
  app.post('/api/sale-sources/test', edit, async (c) => c.json(await domain(async () => svc().test(getCompanyCtx(c).companyId, null, await body(c))), 200))

  app.get('/api/sale-sources/:id', view, async (c) => c.json({ sale_source: await domain(() => svc().get(getCompanyCtx(c).companyId, c.req.param('id'))) }, 200))

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/sale-sources/:id', edit, async (c) => {
      const sale_source = await domain(async () => svc().update(getCompanyCtx(c).companyId, c.req.param('id'), await body(c)))
      setAudit(c, { action: 'sale_sources.update', targetType: 'sale_source', targetId: sale_source.id })
      return c.json({ sale_source }, 200)
    })
  }

  app.delete('/api/sale-sources/:id', del, async (c) => {
    const id = c.req.param('id')
    await domain(() => svc().remove(getCompanyCtx(c).companyId, id))
    setAudit(c, { action: 'sale_sources.delete', targetType: 'sale_source', targetId: id })
    return c.body(null, 204)
  })

  app.post('/api/sale-sources/:id/test', edit, async (c) => c.json(await domain(async () => svc().test(getCompanyCtx(c).companyId, c.req.param('id'), await body(c))), 200))

  app.post('/api/sale-sources/:id/rotate-token', edit, async (c) => {
    const sale_source = await domain(() => svc().rotateToken(getCompanyCtx(c).companyId, c.req.param('id')))
    setAudit(c, { action: 'sale_sources.rotate_token', targetType: 'sale_source', targetId: sale_source.id })
    return c.json({ sale_source }, 200)
  })

  app.get('/api/sale-sources/:id/events', view, async (c) => {
    const q = c.req.query()
    return c.json(
      await domain(() => svc().events(getCompanyCtx(c).companyId, c.req.param('id'), { ...(q.status ? { status: q.status } : {}), ...(q.page ? { page: Number(q.page) } : {}), ...(q.limit ? { limit: Number(q.limit) } : {}) })),
      200,
    )
  })

  app.post('/api/sale-sources/:id/events/:eventId/replay', edit, async (c) => {
    const r = await domain(() => svc().replay(getCompanyCtx(c).companyId, c.req.param('id'), c.req.param('eventId')))
    await enqueue(r.job, { jobId: r.jobId })
    setAudit(c, { action: 'sale_sources.replay', targetType: 'inbound_sale_event', targetId: r.event.id })
    return c.json({ event: r.event }, 202)
  })

  app.get('/api/contacts/:id/attribution', requirePerm('contacts.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const attribution = new AttributionService(deps.db)
    if (!(await attribution.contactExists(companyId, c.req.param('id')).catch(() => false))) throw new ApiError('NOT_FOUND', 'Contato não encontrado')
    return c.json({ attribution: await attribution.get(companyId, c.req.param('id')) }, 200)
  })

  return app
}
