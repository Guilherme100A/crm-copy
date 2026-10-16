// Fluxos padrões por conexão (SPEC T61; 08 §3.3, 17 §3.F): boas-vindas, resposta padrão, conversa/atendimento
// finalizado e palavras-chave. Permissões settings.dispatch.view/edit/delete (Fluxos padrões).
// Registra a fonte de referências de fluxo (T28): fluxo usado por uma conexão não pode ser excluído (409).
import { Hono } from 'hono'
import { z } from 'zod'
import { ConnectionFlowConfigService, FlowTriggersError } from '@crm/core'
import type { Database } from '@crm/db'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { registerFlowReferenceSource } from '../flows/impact'

/** Erros de domínio → SPEC 3.5 (404 conexão de outra empresa; 422 com `details.fields`). */
export async function flowTriggersDomain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FlowTriggersError) {
      if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
      throw new ApiError('VALIDATION_ERROR', err.message, err.details)
    }
    throw err
  }
}

// Formas validadas no serviço (paths do fio); aqui só tipos e tamanhos.
const id = z.string().max(64)
const condition = z.object({ keyword: z.string().max(1000).nullable().optional(), match_type: z.string().max(32).nullable().optional() })
const trigger = z.object({
  id: id.optional(),
  flow_id: id.nullable().optional(),
  rule_type: z.string().max(16).optional(),
  conditions: z.array(condition).max(100).optional(),
  keyword: z.string().max(1000).nullable().optional(),
  match_type: z.string().max(32).nullable().optional(),
  position: z.number().int().optional(),
  active: z.boolean().optional(),
  _destroy: z.boolean().optional(),
})
const triggers = z.array(trigger).max(500)

const fields = {
  welcome_flow_id: id.nullable().optional(),
  default_response_flow_id: id.nullable().optional(),
  default_response_delay_hours: z.number().nullable().optional(),
  finished_conversation_flow_id: id.nullable().optional(),
  finished_attendance_flow_id: id.nullable().optional(),
  keyword_triggers: triggers.optional(),
}

/** `{ connection_flow_config: {...} }` ou o objeto direto; `keyword_triggers_attributes` = `keyword_triggers`. */
function unwrap(v: unknown): unknown {
  let body = v
  if (body && typeof body === 'object' && !Array.isArray(body) && 'connection_flow_config' in body)
    body = (body as { connection_flow_config: unknown }).connection_flow_config
  if (body && typeof body === 'object' && !Array.isArray(body) && 'keyword_triggers_attributes' in body && !('keyword_triggers' in body)) {
    const { keyword_triggers_attributes, ...rest } = body as Record<string, unknown>
    return { ...rest, keyword_triggers: keyword_triggers_attributes }
  }
  return body
}
const putSchema = z.preprocess(unwrap, z.object(fields))

const sentinel = z.enum(['keep', 'clear', '__keep__', '__clear__'])
const bulkSchema = z.object({
  connection_ids: z.array(id).max(500),
  connection_flow_config: z.preprocess(
    (v) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && 'keyword_triggers_attributes' in v && !('keyword_triggers' in v)) {
        const { keyword_triggers_attributes, ...rest } = v as Record<string, unknown>
        return { ...rest, keyword_triggers: keyword_triggers_attributes }
      }
      return v
    },
    z.object({
      welcome_flow_id: z.union([sentinel, id, z.null()]).optional(),
      default_response_flow_id: z.union([sentinel, id, z.null()]).optional(),
      default_response_delay_hours: z.union([sentinel, z.number(), z.null()]).optional(),
      finished_conversation_flow_id: z.union([sentinel, id, z.null()]).optional(),
      finished_attendance_flow_id: z.union([sentinel, id, z.null()]).optional(),
      keyword_triggers: z.union([sentinel, triggers]).optional(),
    }),
  ),
})
const listQuery = z.object({ status: z.enum(['all', 'empty', 'incomplete', 'complete']).optional() })

const registered = new WeakSet<Database>()

/** Uma fonte por banco; banco encerrado remove a própria fonte (testes com vários apps no processo). */
function registerConnectionFlowReferences(db: Database, service: ConnectionFlowConfigService): void {
  if (registered.has(db)) return
  registered.add(db)
  const pool = db.$client as unknown as { ended?: boolean }
  const off = registerFlowReferenceSource(async ({ companyId }, flowId) => {
    if (pool.ended) {
      off()
      return []
    }
    const refs = await service.flowReferences(companyId, flowId)
    return refs.map((r) => ({ kind: 'connection_flow_config' as const, id: r.id, name: r.connectionName }))
  })
}

export function connectionFlowConfigsRoutes(deps: ResolvedDeps) {
  const service = new ConnectionFlowConfigService(deps.db)
  registerConnectionFlowReferences(deps.db, service)
  const app = new Hono<AppEnv>()

  app.get('/api/connection-flow-configs', requirePerm('settings.dispatch.view'), validate('query', listQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await flowTriggersDomain(() => service.list(companyId, c.req.valid('query'))) }, 200)
  })

  app.post('/api/connection-flow-configs/bulk-update', requirePerm('settings.dispatch.edit'), validate('json', bulkSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const body = c.req.valid('json')
    const items = await flowTriggersDomain(() => service.bulkUpdate(companyId, body.connection_ids, body.connection_flow_config))
    setAudit(c, {
      action: 'connection_flow_configs.bulk_update',
      targetType: 'connection_flow_config',
      detail: { connection_ids: body.connection_ids, fields: Object.keys(body.connection_flow_config) },
    })
    return c.json({ items }, 200)
  })

  app.get('/api/connection-flow-configs/:connectionId', requirePerm('settings.dispatch.view'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ connection_flow_config: await flowTriggersDomain(() => service.get(companyId, c.req.param('connectionId'))) }, 200)
  })

  app.put('/api/connection-flow-configs/:connectionId', requirePerm('settings.dispatch.edit'), validate('json', putSchema), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const config = await flowTriggersDomain(() => service.put(companyId, c.req.param('connectionId'), c.req.valid('json')))
    setAudit(c, {
      action: 'connection_flow_configs.update',
      targetType: 'connection_flow_config',
      targetId: config.id ?? undefined,
      detail: { connection_id: config.connection_id, filled: config.filled, keyword_triggers: config.keyword_triggers.length },
    })
    return c.json({ connection_flow_config: config }, 200)
  })

  app.delete('/api/connection-flow-configs/:connectionId', requirePerm('settings.dispatch.delete'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const connectionId = c.req.param('connectionId')
    await flowTriggersDomain(() => service.remove(companyId, connectionId))
    setAudit(c, { action: 'connection_flow_configs.delete', targetType: 'connection_flow_config', detail: { connection_id: connectionId } })
    return c.body(null, 204)
  })

  return app
}
