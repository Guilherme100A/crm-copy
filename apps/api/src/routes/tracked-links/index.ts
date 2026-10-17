// Links rastreáveis (revisão 3; docs/integrations/meta-capi.md) — recurso OPCIONAL para anúncios com destino site/link.
// Anúncio de clique para WhatsApp não passa por link nenhum (o rastreamento ali é o ctwa_clid do cartão do anúncio).
// - CRUD em `/api/meta/tracked-links` (exige `facebook.pixel`), com contagem de cliques, conversas (certas + prováveis,
//   separadas) e vendas.
// - Público `GET /api/w/:slug` (sem sessão, fora do CSRF): grava o clique e responde 302 DIRETO para o wa.me — sem página
//   intermediária. Rate limit por IP; slug desconhecido/inativo → 404 genérico (nada da empresa vaza); `no-store`,
//   `no-referrer` e `noindex`.
import { TrackedLinkError, TrackedLinksService } from '@crm/core'
import { TRACKED_LINK_CODE_MODES } from '@crm/db'
import { Hono } from 'hono'
import { z } from 'zod'
import { clientIp, getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { RateLimiter } from '../../lib/rate-limiter'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Rate limit do link público por IP (default 60/min). */
    trackedLinkRateLimit?: { limit: number; windowMs: number }
  }
}

export const DEFAULT_TRACKED_LINK_RATE_LIMIT = { limit: 60, windowMs: 60_000 }

const text = (max: number) => z.string().max(max).nullable().optional()
const body = z.object({
  name: z.string().max(120).optional(),
  slug: text(63),
  connection_id: text(64),
  phone: text(32),
  message: text(500),
  utm_source: text(255),
  utm_medium: text(255),
  utm_campaign: text(255),
  utm_content: text(255),
  utm_term: text(255),
  active: z.boolean().optional(),
  code_mode: z.enum(TRACKED_LINK_CODE_MODES).optional(),
  probable_match: z.boolean().optional(),
  match_window_minutes: z.number().int().min(1).max(1440).optional(),
})

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof TrackedLinkError)) throw err
    if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
    throw new ApiError(err.code === 'conflict' ? 'CONFLICT' : 'VALIDATION_ERROR', err.message, err.details)
  }
}

export function trackedLinksRoutes(deps: ResolvedDeps) {
  const svc = () => new TrackedLinksService({ db: deps.db })
  const app = new Hono<AppEnv>()
  const perm = requirePerm('facebook.pixel')
  const rate = deps.trackedLinkRateLimit ?? DEFAULT_TRACKED_LINK_RATE_LIMIT
  const limiter = new RateLimiter({ redis: deps.redis, limit: rate.limit, windowMs: rate.windowMs, prefix: 'crm:rl:tracked-link' })

  app.get('/api/meta/tracked-links', perm, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await svc().list(companyId) }, 200)
  })

  app.post('/api/meta/tracked-links', perm, validate('json', body), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const link = await domain(() => svc().create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'meta.tracked_link.create', targetType: 'tracked_link', targetId: link.id, detail: { slug: link.slug } })
    return c.json({ link }, 201)
  })

  app.put('/api/meta/tracked-links/:id', perm, validate('json', body), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const link = await domain(() => svc().update(companyId, id, c.req.valid('json')))
    setAudit(c, { action: 'meta.tracked_link.update', targetType: 'tracked_link', targetId: id })
    return c.json({ link }, 200)
  })

  app.delete('/api/meta/tracked-links/:id', perm, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await domain(() => svc().remove(companyId, id))
    setAudit(c, { action: 'meta.tracked_link.delete', targetType: 'tracked_link', targetId: id })
    return c.body(null, 204)
  })

  app.get('/api/w/:slug', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Robots-Tag', 'noindex, nofollow')
    const ip = clientIp(c, deps.trustProxy)
    const r = await limiter.hit(ip ?? 'anon')
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))))
      throw new ApiError('RATE_LIMIT', 'Muitas requisições; tente novamente mais tarde')
    }
    const out = await svc().click(c.req.param('slug'), { query: c.req.query(), ip, userAgent: c.req.header('user-agent') ?? null })
    if (!out) throw new ApiError('NOT_FOUND', 'Link não encontrado')
    return c.redirect(out.location, 302)
  })

  return app
}
