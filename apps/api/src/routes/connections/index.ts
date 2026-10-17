// Conexões WhatsApp (SPEC T40; 08-conexoes.md §5–§6) sobre o WaGateway. Leitura com connections.view, escrita e
// ações com connections.edit, exclusão agendada com connections.delete (08 §8).
import { CONNECTION_UI_STATUSES, ConnectionPausedFlows, ConnectionsError, ConnectionsService, registerConnectionSessionsSource } from '@crm/core'
import { flowRuns } from '@crm/db'
import type { CredentialCipher } from '@crm/node-kit'
import { inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { flowServices } from '../flow-runs/services'

declare module '../../lib/types' {
  interface AppDeps {
    /** Cifrador da senha do proxy das conexões. Default: o de `CREDENTIALS_KEY`. */
    credentialsCipher?: CredentialCipher
  }
}

const listQuery = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(CONNECTION_UI_STATUSES).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

function toApiError(err: unknown): unknown {
  if (!(err instanceof ConnectionsError)) return err
  const map = {
    not_found: 'NOT_FOUND',
    validation: 'VALIDATION_ERROR',
    limit_reached: 'LIMIT_REACHED',
    invalid_transition: 'INVALID_TRANSITION',
    not_supported: 'VALIDATION_ERROR',
    upstream: 'UPSTREAM_ERROR',
  } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON opcional: corpo vazio vira `{}`; aceita o envelope `{ connection: {...} }` da referência. */
async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError('VALIDATION_ERROR', 'Corpo deve ser um objeto')
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 1 && o.connection && typeof o.connection === 'object' ? (o.connection as Record<string, unknown>) : o
}

export function connectionsRoutes(deps: ResolvedDeps) {
  // T22: desativar a empresa pausa as sessões das conexões dela.
  registerConnectionSessionsSource(deps.db)
  let service: ConnectionsService | undefined
  const svc = () => {
    if (!deps.waGateway) throw new ApiError('INTERNAL', 'WaGateway não configurado')
    service ??= new ConnectionsService({ db: deps.db, gateway: deps.waGateway, ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}) })
    return service
  }
  const app = new Hono<AppEnv>()
  const view = requirePerm('connections.view')
  const edit = requirePerm('connections.edit')
  const del = requirePerm('connections.delete')
  const company = (c: Context<AppEnv>) => getCompanyCtx(c).companyId
  const id = (c: Context<AppEnv>) => c.req.param('id') ?? ''

  app.get('/api/connections', view, validate('query', listQuery), async (c) => {
    return c.json(await domain(() => svc().list(company(c), c.req.valid('query'))), 200)
  })

  app.post('/api/connections', edit, async (c) => {
    const b = await body(c)
    const connection = await domain(() => svc().create(company(c), b, getCompanyCtx(c).user?.id ?? null))
    setAudit(c, { action: 'connections.create', targetType: 'connection', targetId: connection.id, detail: { session_id: connection.session_id } })
    return c.json({ connection }, 201)
  })

  app.get('/api/connections/:id', view, async (c) => c.json({ connection: await domain(() => svc().get(company(c), id(c))) }, 200))

  for (const method of ['put', 'patch'] as const) {
    app[method]('/api/connections/:id', edit, async (c) => {
      const b = await body(c)
      const connection = await domain(() => svc().update(company(c), id(c), b))
      setAudit(c, { action: 'connections.update', targetType: 'connection', targetId: connection.id, detail: { fields: Object.keys(b) } })
      return c.json({ connection }, 200)
    })
  }

  for (const action of ['connect', 'disconnect', 'restart'] as const) {
    app.post(`/api/connections/:id/${action}`, edit, async (c) => {
      const connection = await domain(() => svc()[action](company(c), id(c)))
      setAudit(c, { action: `connections.${action}`, targetType: 'connection', targetId: connection.id })
      return c.json({ connection }, 200)
    })
  }

  app.post('/api/connections/:id/schedule-deletion', del, async (c) => {
    const connection = await domain(() => svc().scheduleDeletion(company(c), id(c)))
    setAudit(c, { action: 'connections.schedule_deletion', targetType: 'connection', targetId: connection.id })
    return c.json({ connection }, 200)
  })

  // QR expõe credencial de pareamento: exige edição (quem pode conectar).
  app.get('/api/connections/:id/qr', edit, async (c) => {
    const qr = await domain(() => svc().qr(company(c), id(c)))
    setAudit(c, { skip: true })
    return c.json(qr, 200)
  })

  app.post('/api/connections/:id/pairing-code', edit, async (c) => {
    const b = await body(c)
    const res = await domain(() => svc().pairingCode(company(c), id(c), b.phone))
    setAudit(c, { action: 'connections.pairing_code', targetType: 'connection', targetId: id(c) })
    return c.json(res, 200)
  })

  app.post('/api/connections/:id/proxy', edit, async (c) => {
    const b = await body(c)
    const connection = await domain(() => svc().setProxy(company(c), id(c), b))
    // Sem a senha na auditoria (SPEC 1.4 nº 8).
    setAudit(c, { action: 'connections.proxy_set', targetType: 'connection', targetId: connection.id, detail: { host: connection.proxy?.host, has_password: connection.proxy?.has_password } })
    return c.json({ connection }, 200)
  })

  app.delete('/api/connections/:id/proxy', edit, async (c) => {
    const connection = await domain(() => svc().removeProxy(company(c), id(c)))
    setAudit(c, { action: 'connections.proxy_remove', targetType: 'connection', targetId: connection.id })
    return c.json({ connection }, 200)
  })

  app.post('/api/connections/:id/instance-settings', edit, async (c) => {
    const b = await body(c)
    const connection = await domain(() => svc().instanceSettings(company(c), id(c), b))
    setAudit(c, { action: 'connections.instance_settings', targetType: 'connection', targetId: connection.id, detail: { fields: Object.keys(b) } })
    return c.json({ connection }, 200)
  })

  // Fluxos pausados na queda (08 §5.13; T71): contagem, Retomar e Cancelar. Mexem em runs: `flows.run`.
  const pausedFlows = () => {
    const flows = flowServices(deps)
    return new ConnectionPausedFlows({
      db: deps.db,
      control: flows.control,
      publisher: { publish: (companyId, type, data) => flows.publisher.publish(companyId, type, data as never) },
    })
  }
  const known = <T>(v: T | null): T => {
    if (v === null) throw new ApiError('NOT_FOUND', 'Conexão não encontrada')
    return v
  }

  app.get('/api/connections/:id/paused-flows', requirePerm('flows.view'), async (c) => c.json(known(await pausedFlows().summary(company(c), id(c))), 200))

  app.post('/api/connections/:id/paused-flows/resume', requirePerm('flows.run'), async (c) => {
    const res = known(await pausedFlows().resume(company(c), id(c)))
    setAudit(c, { action: 'connections.paused_flows_resume', targetType: 'connection', targetId: id(c), detail: { resumed: res.resumed } })
    return c.json(res, 200)
  })

  app.post('/api/connections/:id/paused-flows/cancel', requirePerm('flows.run'), async (c) => {
    const { cancelled } = known(await pausedFlows().cancel(company(c), id(c)))
    if (cancelled.length) {
      const publisher = flowServices(deps).publisher
      const rows = await deps.db.select().from(flowRuns).where(inArray(flowRuns.id, cancelled))
      for (const r of rows)
        await publisher
          .publish(company(c), 'flow_run.cancelled', { run_id: r.id, flow_id: r.flowId, contact_id: r.contactId, chat_id: r.chatId, status: r.status })
          .catch(() => undefined)
    }
    setAudit(c, { action: 'connections.paused_flows_cancel', targetType: 'connection', targetId: id(c), detail: { cancelled: cancelled.length } })
    return c.json({ cancelled: cancelled.length }, 200)
  })

  app.get('/api/connections/:id/whatsapp-profile', view, async (c) => c.json({ profile: await domain(() => svc().getProfile(company(c), id(c))) }, 200))

  app.patch('/api/connections/:id/whatsapp-profile', edit, async (c) => {
    const b = await body(c)
    const profile = await domain(() => svc().updateProfile(company(c), id(c), b))
    setAudit(c, { action: 'connections.profile_update', targetType: 'connection', targetId: id(c), detail: { fields: Object.keys(b) } })
    return c.json({ profile }, 200)
  })

  return app
}
