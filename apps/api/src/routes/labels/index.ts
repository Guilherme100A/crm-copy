// Etiquetas (SPEC T26; 17 §3.E). Permissões settings.labels.view/edit/delete (catálogo 16 §8).
import { Hono } from 'hono'
import { z } from 'zod'
import { LabelsService } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { domain } from '../contacts/shared'

// Tamanho e formato são validados no serviço (422 com `details.fields`), para uma regra só.
const labelBody = z.object({ name: z.string().max(200), color: z.string().max(20) }).strict()
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'label' in v && Object.keys(v).length === 1 ? (v as { label: unknown }).label : v
const createSchema = z.preprocess(unwrap, labelBody)
const updateSchema = z.preprocess(unwrap, labelBody.partial())

export function labelsRoutes(deps: ResolvedDeps) {
  const service = new LabelsService(deps.db)
  const app = new Hono<AppEnv>()

  app.get('/api/labels', requirePerm('settings.labels.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.list(companyId)) }, 200)
  })

  app.post('/api/labels', requirePerm('settings.labels.edit'), validate('json', createSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const label = await domain(() => service.create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'labels.create', targetType: 'label', targetId: label.id })
    return c.json({ label }, 201)
  })

  app.get('/api/labels/:id', requirePerm('settings.labels.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ label: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/labels/:id', requirePerm('settings.labels.edit'), validate('json', updateSchema), async (c) => {
      const { companyId } = getCompanyCtx(c)
      const label = await domain(() => service.update(companyId, c.req.param('id'), c.req.valid('json')))
      setAudit(c, { action: 'labels.update', targetType: 'label', targetId: label.id })
      return c.json({ label }, 200)
    })
  }

  app.delete('/api/labels/:id', requirePerm('settings.labels.delete'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await domain(() => service.delete(companyId, id))
    setAudit(c, { action: 'labels.delete', targetType: 'label', targetId: id })
    return c.body(null, 204)
  })

  return app
}
