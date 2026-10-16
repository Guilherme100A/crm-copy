// Perfis Meta e contas de anúncio (SPEC T99; 11 §5.1, §6, §8). Ler: `facebook.profiles`; escrever (remover,
// atualizar lista, marcar conta no dashboard): `facebook.profiles` + owner/admin. Nenhuma resposta traz o token.
import { Hono } from 'hono'
import { z } from 'zod'
import { getCompanyCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { metaDomain, metaProfilesServiceFor, requireMetaManager } from './shared'

const adAccountSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'meta_ad_account' in v ? (v as { meta_ad_account: unknown }).meta_ad_account : v),
  z.object({ included_in_dashboard: z.boolean() }),
)

export function metaProfilesRoutes(deps: ResolvedDeps) {
  const svc = () => metaProfilesServiceFor(deps)
  const app = new Hono<AppEnv>()
  const view = requirePerm('facebook.profiles')

  app.get('/api/meta/profiles', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await metaDomain(() => svc().list(companyId)) }, 200)
  })

  app.get('/api/meta/profiles/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ profile: await metaDomain(() => svc().get(companyId, c.req.param('id'))) }, 200)
  })

  app.delete('/api/meta/profiles/:id', view, requireMetaManager, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await metaDomain(() => svc().remove(companyId, id))
    setAudit(c, { action: 'meta.profile.delete', targetType: 'meta_profile', targetId: id })
    return c.body(null, 204)
  })

  app.post('/api/meta/profiles/:id/refresh-ad-accounts', view, requireMetaManager, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const profile = await metaDomain(() => svc().refreshAdAccounts(companyId, id))
    setAudit(c, { action: 'meta.profile.refresh_ad_accounts', targetType: 'meta_profile', targetId: id, detail: { ad_accounts: profile.ad_accounts_count } })
    return c.json({ profile }, 200)
  })

  app.put('/api/meta/ad-accounts/:id', view, requireMetaManager, validate('json', adAccountSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const { included_in_dashboard } = c.req.valid('json')
    const account = await metaDomain(() => svc().setIncluded(companyId, id, included_in_dashboard))
    setAudit(c, { action: 'meta.ad_account.update', targetType: 'meta_ad_account', targetId: id, detail: { included_in_dashboard } })
    return c.json({ ad_account: account }, 200)
  })

  return app
}
