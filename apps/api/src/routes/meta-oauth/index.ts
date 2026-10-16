// OAuth da Meta (SPEC T99; 11 §5.1, §4.6). `start` devolve a URL do Facebook Login com `state` assinado (empresa +
// usuário da sessão); o `callback` volta do navegador com a sessão (cookie SameSite=Lax numa navegação de topo),
// confere o `state` contra a sessão e SEMPRE redireciona para `/facebook/profiles?meta_oauth=success|error`.
import { Hono } from 'hono'
import { z } from 'zod'
import { MetaProfilesError, metaConfigFromEnv } from '@crm/core'
import { getCompanyCtx, getCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { canManageMetaProfiles, metaDomain, metaProfilesServiceFor, requireMetaManager } from '../meta-profiles/shared'

const startSchema = z.object({ profile_id: z.string().max(64).nullable().optional() })

/** Mensagem curta e sem segredos para `meta_message`. */
const short = (msg: string) => msg.replace(/\s+/g, ' ').slice(0, 200)

export function metaOAuthRoutes(deps: ResolvedDeps) {
  const svc = () => metaProfilesServiceFor(deps)
  const webUrl = () => ({ ...metaConfigFromEnv(), ...deps.metaConfig }).webUrl
  const app = new Hono<AppEnv>()

  app.post('/api/meta/oauth/start', requirePerm('facebook.profiles'), requireMetaManager, validate('json', startSchema), async (c) => {
    const ctx = getCompanyCtx(c)
    const body = c.req.valid('json')
    const { oauth_url } = await metaDomain(() => svc().startOAuth({ companyId: ctx.companyId, userId: ctx.user!.id, profileId: body.profile_id ?? null }))
    setAudit(c, { action: 'meta.oauth.start', targetType: 'meta_profile', ...(body.profile_id ? { targetId: body.profile_id } : {}) })
    return c.json({ oauth_url }, 200)
  })

  app.get('/api/meta/oauth/callback', async (c) => {
    const back = (status: 'success' | 'error', message?: string) => {
      const url = new URL('/facebook/profiles', webUrl())
      url.searchParams.set('meta_oauth', status)
      if (message) url.searchParams.set('meta_message', short(message))
      return c.redirect(url.toString(), 302)
    }
    const ctx = getCtx(c)
    const q = c.req.query()
    if (q.error) return back('error', q.error_description || q.error_reason || q.error)
    if (!ctx.companyId || !ctx.user || !canManageMetaProfiles(ctx)) return back('error', 'Sem permissão para conectar perfis Meta')
    try {
      const profile = await svc().completeOAuth({ companyId: ctx.companyId, userId: ctx.user.id, code: q.code, state: q.state })
      setAudit(c, { action: 'meta.oauth.connect', targetType: 'meta_profile', targetId: profile.id, detail: { ad_accounts: profile.ad_accounts_count } })
      return back('success')
    } catch (err) {
      if (err instanceof MetaProfilesError) return back('error', err.message)
      deps.logger?.error({ err }, 'meta oauth callback falhou')
      return back('error', 'Falha ao conectar o perfil Meta')
    }
  })

  return app
}
