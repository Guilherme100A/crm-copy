// Dashboard (SPEC T55; 02-dashboard.md §3.1–3.4, §6): `GET /api/dashboard` (bloco de vendas só com dashboard.sales,
// cache Redis 5 min) e `GET /api/dashboard/bootstrap`. Exige dashboard.sales ou dashboard.support.
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { dashboardBootstrap, DashboardQueryError, SalesDashboardService, type AdSpendProvider, type DashboardCache } from '@crm/core'
import { getCompanyCtx, getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, RedisClient, ResolvedDeps } from '../../lib/types'

declare module '../../lib/types' {
  interface AppDeps {
    /** Gasto Meta do período (fake nos testes). Default: o registrado pela T101, senão 0. */
    adSpendProvider?: AdSpendProvider
    /** TTL do cache do dashboard em ms (default 300 000). */
    dashboardCacheTtlMs?: number
  }
}

const anyDashboard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = getCtx(c)
  const perms = ctx.perms as ReadonlySet<string>
  if (!ctx.companyId || !(perms.has('dashboard.sales') || perms.has('dashboard.support')))
    throw new ApiError('FORBIDDEN', 'Permissão insuficiente', { permission: 'dashboard.sales|dashboard.support' })
  return next()
}

function redisCache(redis: RedisClient): DashboardCache {
  return {
    get: async (key) => redis.get(key),
    set: async (key, value, ttlMs) => {
      await redis.set(key, value, 'PX', ttlMs)
    },
  }
}

/** `connection_ids[]=a&connection_ids[]=b`, `connection_ids=a,b` ou `connection_id=a`. */
function idsOf(c: Context<AppEnv>, name: string): string[] {
  const all = [...(c.req.queries(`${name}s[]`) ?? []), ...(c.req.queries(`${name}s`) ?? []), ...(c.req.queries(name) ?? [])]
  return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}

const flag = (v: string | undefined) => v === '1' || v === 'true'

export function dashboardRoutes(deps: ResolvedDeps) {
  const service = new SalesDashboardService({
    db: deps.db,
    cache: redisCache(deps.redis),
    ...(deps.adSpendProvider ? { adSpend: deps.adSpendProvider } : {}),
    ...(deps.dashboardCacheTtlMs !== undefined ? { cacheTtlMs: deps.dashboardCacheTtlMs } : {}),
  })
  const app = new Hono<AppEnv>()
  const canSales = (c: Context<AppEnv>) => (getCompanyCtx(c).perms as ReadonlySet<string>).has('dashboard.sales')

  app.get('/api/dashboard/bootstrap', anyDashboard, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await dashboardBootstrap(deps.db, companyId, { includeSales: canSales(c), locale: c.req.query('locale') ?? 'pt-BR' }), 200)
  })

  app.get('/api/dashboard', anyDashboard, async (c) => {
    const { companyId } = getCompanyCtx(c)
    try {
      const result = await service.get(
        companyId,
        {
          ...(c.req.query('start_date') ? { start_date: c.req.query('start_date')! } : {}),
          ...(c.req.query('end_date') ? { end_date: c.req.query('end_date')! } : {}),
          connection_ids: idsOf(c, 'connection_id'),
          product_ids: idsOf(c, 'product_id'),
        },
        { includeSales: canSales(c), forceRefresh: flag(c.req.query('force_refresh')) },
      )
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof DashboardQueryError) throw new ApiError('VALIDATION_ERROR', err.message, { fields: err.fields })
      throw err
    }
  })

  return app
}
