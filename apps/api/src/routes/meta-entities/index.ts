// Edição na Meta pelo Gerenciador (SPEC T103; 11 §5.3, §6): `PATCH /api/meta/structure-entities/:id` com
// `{ level, fb_ad_account_id, status?, name?, daily_budget?, lifetime_budget? }` → `{ success: true, entity }`.
// Permissão `facebook.campaigns`. Erro da Meta → 502 "Não foi possível atualizar na Meta."; limite de uso → 429.
// Depois de editar, o cache de 5 min dos bundles da empresa é invalidado.
import { MetaBundleService, MetaMutationError, MetaMutationsService } from '@crm/core'
import { InternalSalesService } from '@crm/core'
import { Hono } from 'hono'
import { z } from 'zod'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { metaDomain, metaProfilesServiceFor } from '../meta-profiles/shared'

const money = z.union([z.string().max(32), z.number()]).nullish()
// A validação de regra (nível × campo, conta obrigatória, valores) é do serviço: aqui só o formato.
const bodySchema = z.object({
  level: z.string().max(16).optional(),
  fb_ad_account_id: z.union([z.string().max(64), z.number()]).nullish(),
  status: z.string().max(16).nullish(),
  name: z.string().max(1000).nullish(),
  daily_budget: money,
  lifetime_budget: money,
})

export function metaEntitiesRoutes(deps: ResolvedDeps) {
  let service: MetaMutationsService | undefined
  const svc = () =>
    (service ??= new MetaMutationsService({
      db: deps.db,
      redis: deps.redis,
      profiles: metaProfilesServiceFor(deps),
      // T105: `internalSales` com a mesma cotação deste bundle (default `META_FX_RATES`).
      bundles: new MetaBundleService({ db: deps.db, redis: deps.redis, profiles: metaProfilesServiceFor(deps), internalSales: new InternalSalesService({ db: deps.db }) }),
    }))
  const app = new Hono<AppEnv>()

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/meta/structure-entities/:id', requirePerm('facebook.campaigns'), validate('json', bodySchema), async (c) => {
      const { companyId } = getCompanyCtx(c)
      const id = c.req.param('id')
      const body = c.req.valid('json')
      const result = await metaDomain(async () => {
        try {
          return await svc().update(companyId, id, body)
        } catch (err) {
          if (!(err instanceof MetaMutationError)) throw err
          if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
          if (err.code === 'validation') throw new ApiError('VALIDATION_ERROR', err.message, err.details)
          if (err.code === 'rate_limited') throw new ApiError('RATE_LIMIT', err.message, { error_code: 'meta_rate_limited', ...err.details })
          throw new ApiError('UPSTREAM_ERROR', err.message, { error_code: 'meta_update_failed', ...err.details })
        }
      })
      setAudit(c, { action: 'meta.entity.update', targetType: `meta_${result.entity.level}`, targetId: id, detail: { fb_ad_account_id: result.entity.fb_ad_account_id, fields: Object.keys(result.sent) } })
      return c.json({ success: true, entity: result.entity }, 200)
    })
  }

  return app
}
