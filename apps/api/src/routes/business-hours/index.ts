// Horários de atendimento por conexão (SPEC T31; 16 §3.3). Permissões settings.business_hours.view/edit.
// Registra a fonte de referências de fluxo (T28): fluxo usado por um horário não pode ser excluído (409).
import { Hono } from 'hono'
import { z } from 'zod'
import { BusinessHoursService } from '@crm/core'
import { BUSINESS_HOUR_ACTIONS, type Database } from '@crm/db'
import { getCompanyCtx } from '../../lib/context'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { departmentsDomain } from '../departments/index'
import { registerFlowReferenceSource } from '../flows/impact'

// Regras de negócio (mensagem/fluxo obrigatórios, horários HH:MM) validadas no serviço, com os paths do fio.
const interval = z.object({
  day_of_week: z.number().int(),
  start_time: z.string().max(5),
  end_time: z.string().max(5),
  active: z.boolean().optional(),
})
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'business_hour_config' in v ? (v as { business_hour_config: unknown }).business_hour_config : v
const putSchema = z.preprocess(
  unwrap,
  z.object({
    active: z.boolean(),
    action_type: z.enum(BUSINESS_HOUR_ACTIONS).optional(),
    message_text: z.string().max(4096).nullable().optional(),
    flow_id: z.string().max(64).nullable().optional(),
    business_hours: z.array(interval).max(200).optional(),
  }),
)

const registered = new WeakSet<Database>()

/** Uma fonte por banco; banco encerrado remove a própria fonte (testes com vários apps no processo). */
function registerBusinessHourReferences(db: Database, service: BusinessHoursService): void {
  if (registered.has(db)) return
  registered.add(db)
  const pool = db.$client as unknown as { ended?: boolean }
  const off = registerFlowReferenceSource(async ({ companyId }, flowId) => {
    if (pool.ended) {
      off()
      return []
    }
    const refs = await service.flowReferences(companyId, flowId)
    return refs.map((r) => ({ kind: 'business_hour_config' as const, id: r.id, name: r.connectionId }))
  })
}

export function businessHoursRoutes(deps: ResolvedDeps) {
  const service = new BusinessHoursService(deps.db)
  registerBusinessHourReferences(deps.db, service)
  const app = new Hono<AppEnv>()

  app.get('/api/business-hours/:connectionId', requirePerm('settings.business_hours.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ config: await departmentsDomain(() => service.get(companyId, c.req.param('connectionId'))) }, 200)
  })

  app.put('/api/business-hours/:connectionId', requirePerm('settings.business_hours.edit'), validate('json', putSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const config = await departmentsDomain(() => service.put(companyId, c.req.param('connectionId'), c.req.valid('json')))
    setAudit(c, {
      action: 'business_hours.update',
      targetType: 'business_hour_config',
      targetId: config.id ?? undefined,
      detail: { connection_id: config.connection_id, active: config.active, intervals: config.business_hours.length },
    })
    return c.json({ config }, 200)
  })

  return app
}
