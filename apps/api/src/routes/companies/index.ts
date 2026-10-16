// Empresas (T22): `GET|POST /api/companies`, `GET|PUT|DELETE /api/companies/:id`, `POST /api/companies/:id/switch|leave`.
// Não-membro → 404. O guard `companyActiveGuard` bloqueia o resto da API quando a empresa ativa está desativada.
import { Hono } from 'hono'
import { z } from 'zod'
import { companySlugSchema, pageQuerySchema } from '@crm/shared'
import { setAudit } from '../../middleware/audit'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { actorOf, run, teamServices } from '../team/support'

export { companyActiveGuard, isCompanyInactiveExempt } from './guard'

/** Aceita `{ account: {…} }` / `{ company: {…} }` (produto de referência) ou o corpo direto. */
const unwrap = (v: unknown) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    for (const k of ['account', 'company']) if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) return o[k]
  }
  return v
}

const name = z.string().trim().min(1).max(120)
const description = z.string().max(2000).nullish()
const timeZone = z.string().trim().min(1).max(64)

const createSchema = z.preprocess(unwrap, z.object({ name, slug: companySlugSchema.optional(), description, time_zone: timeZone.optional() }))
const updateSchema = z.preprocess(
  unwrap,
  z.object({
    name: name.optional(),
    slug: companySlugSchema.optional(),
    description,
    time_zone: timeZone.optional(),
    connection_status_emails_enabled: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
)
const listQuery = pageQuerySchema.extend({ search: z.string().trim().max(120).optional() })

export function companiesRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const svc = () => teamServices(deps).companies

  app.get('/api/companies', validate('query', listQuery), async (c) => {
    const actor = actorOf(c)
    const q = c.req.valid('query')
    return c.json(await run(() => svc().list(actor.userId, { page: q.page, limit: q.limit, search: q.search || undefined })))
  })

  app.post('/api/companies', validate('json', createSchema), async (c) => {
    const actor = actorOf(c)
    const body = c.req.valid('json')
    const company = await run(() => svc().create(actor, { name: body.name, slug: body.slug, description: body.description, timeZone: body.time_zone }))
    setAudit(c, { action: 'company.create', targetType: 'company', targetId: company.id })
    return c.json({ company }, 201)
  })

  app.get('/api/companies/:id', async (c) => {
    const actor = actorOf(c)
    return c.json({ company: await run(() => svc().get(actor, c.req.param('id'))) })
  })

  app.put('/api/companies/:id', validate('json', updateSchema), async (c) => {
    const actor = actorOf(c)
    const b = c.req.valid('json')
    const company = await run(() =>
      svc().update(actor, c.req.param('id'), {
        name: b.name,
        slug: b.slug,
        description: b.description,
        timeZone: b.time_zone,
        connectionStatusEmailsEnabled: b.connection_status_emails_enabled,
        active: b.active,
      }),
    )
    setAudit(c, { action: b.active === true ? 'company.reactivate' : b.active === false ? 'company.deactivate' : 'company.update', targetType: 'company', targetId: company.id })
    return c.json({ company })
  })

  // Desativação (soft delete): bloqueia o acesso e pausa as sessões WhatsApp.
  app.delete('/api/companies/:id', async (c) => {
    const actor = actorOf(c)
    const r = await run(() => svc().deactivate(actor, c.req.param('id')))
    setAudit(c, { action: 'company.deactivate', targetType: 'company', targetId: r.company.id, detail: { paused_session_ids: r.pausedSessionIds } })
    return c.json({ company: r.company, paused_session_ids: r.pausedSessionIds })
  })

  app.post('/api/companies/:id/switch', async (c) => {
    const actor = actorOf(c)
    const r = await run(() => svc().switch(actor, c.req.param('id')))
    setAudit(c, { action: 'company.switch', targetType: 'company', targetId: r.company.id })
    return c.json(r)
  })

  app.post('/api/companies/:id/leave', async (c) => {
    const actor = actorOf(c)
    const id = c.req.param('id')
    await run(() => svc().leave(actor, id))
    setAudit(c, { action: 'company.leave', targetType: 'company', targetId: id })
    return c.json({ left: true })
  })

  return app
}
