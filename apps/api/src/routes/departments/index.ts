// Departamentos (SPEC T31; 16 §3.2, §5) e escopo de chat por membro. Permissões settings.departments.*;
// o escopo do membro é edição de equipe (team.view/edit). Registra o filtro de escopo do realtime (T16).
import { Hono } from 'hono'
import { z } from 'zod'
import { DepartmentsError, DepartmentsService, registerChatScopeFilter } from '@crm/core'
import { pageQuerySchema } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

/** `DepartmentsError` (not_found 404, validation 422) → erro da API. */
export function toDepartmentsApiError(err: unknown): unknown {
  if (!(err instanceof DepartmentsError)) return err
  return err.code === 'not_found' ? new ApiError('NOT_FOUND', err.message) : new ApiError('VALIDATION_ERROR', err.message, err.details)
}

export async function departmentsDomain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toDepartmentsApiError(err)
  }
}

// Formato e tamanho validados no serviço (422 com `details.fields`), para uma regra só.
const body = z.object({ name: z.string().max(500).optional(), color: z.string().max(50).nullable().optional() })
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'department' in v && Object.keys(v).length === 1 ? (v as { department: unknown }).department : v
const writeSchema = z.preprocess(unwrap, body)
const listQuery = pageQuerySchema.extend({ search: z.string().max(200).optional() })
const scopeSchema = z.object({
  department_ids: z.array(z.string().max(64)).max(200).optional(),
  connection_ids: z.array(z.string().max(64)).max(200).optional(),
})

export function departmentsRoutes(deps: ResolvedDeps) {
  const service = new DepartmentsService(deps.db)
  registerChatScopeFilter(deps.db)
  const app = new Hono<AppEnv>()

  app.get('/api/departments', requirePerm('settings.departments.view'), validate('query', listQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await departmentsDomain(() => service.list(companyId, c.req.valid('query'))), 200)
  })

  app.get('/api/departments/all', requirePerm('settings.departments.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await departmentsDomain(() => service.all(companyId)) }, 200)
  })

  app.get('/api/departments/members/:memberId/scope', requirePerm('team.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ scope: await departmentsDomain(() => service.getMemberScope(companyId, c.req.param('memberId'))) }, 200)
  })

  app.put('/api/departments/members/:memberId/scope', requirePerm('team.edit'), validate('json', scopeSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const scope = await departmentsDomain(() => service.setMemberScope(companyId, c.req.param('memberId'), c.req.valid('json')))
    setAudit(c, { action: 'team.chat_scope.update', targetType: 'company_member', targetId: scope.member_id, detail: { ...scope } })
    return c.json({ scope }, 200)
  })

  app.post('/api/departments', requirePerm('settings.departments.edit'), validate('json', writeSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const department = await departmentsDomain(() => service.create(companyId, c.req.valid('json')))
    setAudit(c, { action: 'departments.create', targetType: 'department', targetId: department.id })
    return c.json({ department }, 201)
  })

  app.get('/api/departments/:id', requirePerm('settings.departments.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ department: await departmentsDomain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/departments/:id', requirePerm('settings.departments.edit'), validate('json', writeSchema), async (c) => {
      const { companyId } = getCompanyCtx(c)
      const department = await departmentsDomain(() => service.update(companyId, c.req.param('id'), c.req.valid('json')))
      setAudit(c, { action: 'departments.update', targetType: 'department', targetId: department.id })
      return c.json({ department }, 200)
    })
  }

  app.delete('/api/departments/:id', requirePerm('settings.departments.delete'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    await departmentsDomain(() => service.delete(companyId, id))
    setAudit(c, { action: 'departments.delete', targetType: 'department', targetId: id })
    return c.body(null, 204)
  })

  return app
}
