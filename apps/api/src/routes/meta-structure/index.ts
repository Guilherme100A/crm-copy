// Gerenciador Meta (SPEC T101; 11 §3.5, §5.2): `GET /api/meta/structure-bundle`. Permissão `facebook.campaigns`.
// `async=1`: 202 com o estado (`loading|refreshing|partial`) até o job terminar; o cliente acompanha pelo SSE
// `meta.bundle.progress` e relê a mesma URL (pronto em cache → 200). Sem `async`, monta na hora (200).
import { Hono } from 'hono'
import { defineQueue, META_SYNC_QUEUE, MetaBundleError, MetaBundleService, RealtimePublisher, type MetaSyncJobData } from '@crm/core'
import { InternalSalesService } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { metaDomain, metaProfilesServiceFor } from '../meta-profiles/shared'

declare module '../../lib/types' {
  interface AppDeps {
    /** Enfileira o job `meta-sync` (default: fila BullMQ `meta-sync` pelo `REDIS_URL`/`CRM_QUEUE_PREFIX`). */
    metaSyncEnqueue?: (data: MetaSyncJobData, opts: { jobId: string }) => Promise<void>
    /** Cotação para a moeda de exibição (default: `META_FX_RATES`). */
    metaFx?: (from: string, to: string) => number | null
  }
}

const flag = (v: string | undefined) => v === '1' || v === 'true'

export function metaStructureRoutes(deps: ResolvedDeps) {
  let queue: ReturnType<typeof defineQueue<MetaSyncJobData>> | undefined
  let service: MetaBundleService | undefined
  const svc = () =>
    (service ??= new MetaBundleService({
      db: deps.db,
      redis: deps.redis,
      profiles: metaProfilesServiceFor(deps),
      publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
      enqueue:
        deps.metaSyncEnqueue ??
        (async (data, opts) => {
          queue ??= defineQueue<MetaSyncJobData>(META_SYNC_QUEUE, { defaultJobOptions: { attempts: 1 } })
          await queue.add(META_SYNC_QUEUE, data, { jobId: opts.jobId })
        }),
      ...(deps.metaFx ? { fx: deps.metaFx } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      // T105: vendas internas × anúncios (mesma cotação do bundle).
      internalSales: new InternalSalesService({ db: deps.db, ...(deps.metaFx ? { fx: deps.metaFx } : {}) }),
    }))
  const app = new Hono<AppEnv>()

  app.get('/api/meta/structure-bundle', requirePerm('facebook.campaigns'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const q = c.req.query()
    // `ad_account_ids[]=a&ad_account_ids[]=b`, `ad_account_ids=a,b` ou repetido.
    const ids = [...(c.req.queries('ad_account_ids[]') ?? []), ...(c.req.queries('ad_account_ids') ?? [])].flatMap((v) => v.split(','))
    const async = flag(q.async)
    const bundle = await metaDomain(async () => {
      try {
        return await svc().getBundle(companyId, {
          ...(q.level ? { level: q.level } : {}),
          ...((q.status_filter ?? q.status) ? { status_filter: q.status_filter ?? q.status } : {}),
          ...(q.date_preset ? { date_preset: q.date_preset } : {}),
          ...((q.since ?? q.start_date) ? { since: q.since ?? q.start_date } : {}),
          ...((q.until ?? q.end_date) ? { until: q.until ?? q.end_date } : {}),
          ...((q.display_currency ?? q.meta_display_currency) ? { display_currency: q.display_currency ?? q.meta_display_currency } : {}),
          ad_account_ids: ids,
          force_refresh: flag(q.force_refresh),
          async,
        })
      } catch (err) {
        if (err instanceof MetaBundleError) throw new ApiError(err.code === 'not_found' ? 'NOT_FOUND' : 'VALIDATION_ERROR', err.message, err.details)
        throw err
      }
    })
    return c.json(bundle, async && bundle.status !== 'ready' ? 202 : 200)
  })

  return app
}
