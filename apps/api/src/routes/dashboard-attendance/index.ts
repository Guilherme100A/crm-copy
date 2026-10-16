// Dashboard de atendimento (SPEC T65; 02 §3.3, §5): `GET /api/dashboard/attendance` com o mesmo padrão da T55
// (fuso da empresa, período anterior, cache Redis 5 min, `force_refresh`), limitado a 92 dias. Exige dashboard.support.
import { AttendanceDashboardService, DashboardQueryError } from '@crm/core'
import { Hono, type Context } from 'hono'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'

/** `connection_ids[]=a&connection_ids[]=b`, `connection_ids=a,b` ou `connection_id=a`. */
function connectionIdsOf(c: Context<AppEnv>): string[] {
  const all = [...(c.req.queries('connection_ids[]') ?? []), ...(c.req.queries('connection_ids') ?? []), ...(c.req.queries('connection_id') ?? [])]
  return all.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}

const flag = (v: string | undefined) => v === '1' || v === 'true'

export function dashboardAttendanceRoutes(deps: ResolvedDeps) {
  const service = new AttendanceDashboardService({
    db: deps.db,
    cache: {
      get: async (key) => deps.redis.get(key),
      set: async (key, value, ttlMs) => {
        await deps.redis.set(key, value, 'PX', ttlMs)
      },
    },
    // Mesmo TTL configurável da T55 (`dashboardCacheTtlMs`).
    ...(deps.dashboardCacheTtlMs !== undefined ? { cacheTtlMs: deps.dashboardCacheTtlMs } : {}),
  })
  const app = new Hono<AppEnv>()

  app.get('/api/dashboard/attendance', requirePerm('dashboard.support'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    try {
      const result = await service.get(
        companyId,
        {
          ...(c.req.query('start_date') ? { start_date: c.req.query('start_date')! } : {}),
          ...(c.req.query('end_date') ? { end_date: c.req.query('end_date')! } : {}),
          connection_ids: connectionIdsOf(c),
        },
        { forceRefresh: flag(c.req.query('force_refresh')) },
      )
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof DashboardQueryError) throw new ApiError('VALIDATION_ERROR', err.message, { fields: err.fields })
      throw err
    }
  })

  return app
}
