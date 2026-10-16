// Catálogo de campos personalizados (SPEC T26; 05 §3.2, 17 §3.D). Chave imutável; o PATCH só aceita a descrição.
// Permissões settings.fields.view/edit (catálogo 16 §8). Não há exclusão (como no produto de referência).
import { Hono } from 'hono'
import { z } from 'zod'
import { CustomFieldsService } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { domain } from '../contacts/shared'

const createSchema = z.object({ key: z.string().max(1000), description: z.string().max(2000).nullish() }).strict()
/** Só a descrição: qualquer outro campo (inclusive `key`) → 422. */
const updateSchema = z.object({ description: z.string().max(2000).nullable() }).strict()

export function customFieldsRoutes(deps: ResolvedDeps) {
  const service = new CustomFieldsService(deps.db)
  const app = new Hono<AppEnv>()

  app.get('/api/custom-fields', requirePerm('settings.fields.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.list(companyId)) }, 200)
  })

  app.post('/api/custom-fields', requirePerm('settings.fields.edit'), validate('json', createSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const field = await domain(() => service.create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'custom_fields.create', targetType: 'custom_field', targetId: field.key })
    return c.json({ custom_field: field }, 201)
  })

  app.patch('/api/custom-fields/:key', requirePerm('settings.fields.edit'), validate('json', updateSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const key = decodeURIComponent(c.req.param('key'))
    const field = await domain(() => service.updateDescription(companyId, key, c.req.valid('json').description))
    setAudit(c, { action: 'custom_fields.update', targetType: 'custom_field', targetId: field.key })
    return c.json({ custom_field: field }, 200)
  })

  return app
}
