// Produtos (SPEC T34; 19 §3.5, §5.7). Permissões settings.products.view/edit/delete (16 §8.1).
import { Hono } from 'hono'
import { z } from 'zod'
import { ProductsService, SalesError } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

/** `SalesError` (not_found 404, conflict 409, validation 422) → erro da API. Usado também pelas rotas de vendas. */
export function salesApiError(err: unknown): unknown {
  if (!(err instanceof SalesError)) return err
  if (err.code === 'not_found') return new ApiError('NOT_FOUND', err.message)
  if (err.code === 'conflict') return new ApiError('CONFLICT', err.message, err.details)
  return new ApiError('VALIDATION_ERROR', err.message, err.details)
}

export async function salesDomain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw salesApiError(err)
  }
}

// Regras (faixa, fallback > 0, moeda ISO) ficam no serviço para os paths sairem iguais em criar e editar.
const body = z.object({
  name: z.string().max(1000).optional(),
  currency: z.string().max(10).optional(),
  price_min_cents: z.number().optional(),
  price_max_cents: z.number().optional(),
  price_fallback_cents: z.number().optional(),
})
const unwrap = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) && 'product' in v && Object.keys(v).length === 1 ? (v as { product: unknown }).product : v)
const writeSchema = z.preprocess(unwrap, body)

export function productsRoutes(deps: ResolvedDeps) {
  const service = new ProductsService(deps.db)
  const app = new Hono<AppEnv>()

  app.get('/api/products', requirePerm('settings.products.view'), validate('query', z.object({ search: z.string().max(200).optional() })), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await salesDomain(() => service.list(companyId, c.req.valid('query'))) }, 200)
  })

  app.post('/api/products', requirePerm('settings.products.edit'), validate('json', writeSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const product = await salesDomain(() => service.create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'products.create', targetType: 'product', targetId: product.id })
    return c.json({ product }, 201)
  })

  app.get('/api/products/:id', requirePerm('settings.products.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ product: await salesDomain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/products/:id', requirePerm('settings.products.edit'), validate('json', writeSchema), async (c) => {
      const { companyId } = getCompanyCtx(c)
      const product = await salesDomain(() => service.update(companyId, c.req.param('id'), c.req.valid('json')))
      setAudit(c, { action: 'products.update', targetType: 'product', targetId: product.id })
      return c.json({ product }, 200)
    })
  }

  app.delete('/api/products/:id', requirePerm('settings.products.delete'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await salesDomain(() => service.delete(companyId, id))
    setAudit(c, { action: 'products.delete', targetType: 'product', targetId: id })
    return c.body(null, 204)
  })

  return app
}
