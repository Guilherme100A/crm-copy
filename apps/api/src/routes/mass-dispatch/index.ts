// Disparos em massa (T60; 10 §6): cota, lista/detalhe/destinatários (contacts.view), criação por multipart ou JSON
// com manifesto do público e cancelamento (mass_dispatch.create). A preparação/envio é da T74 (fila `mass-dispatch`).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
  MASS_DISPATCH_QUEUE,
  MassDispatchError,
  MassDispatchService,
  bullMassDispatchJobs,
  defineQueue,
  type CreateMassDispatchInput,
  type MassDispatchJobData,
  type MassDispatchJobs,
  type TargetInput,
} from '@crm/core'
import { pageQuerySchema, type ErrorCode } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Jobs da fila `mass-dispatch` (padrão: BullMQ pelo `REDIS_URL`); injetável nos testes. */
    massDispatchJobs?: MassDispatchJobs
  }
}

const CODE: Record<MassDispatchError['code'], ErrorCode> = {
  invalid: 'VALIDATION_ERROR',
  not_found: 'NOT_FOUND',
  session_not_connected: 'SESSION_NOT_CONNECTED',
  quota_exceeded: 'QUOTA_EXCEEDED',
  invalid_transition: 'INVALID_TRANSITION',
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof MassDispatchError) throw new ApiError(CODE[err.code], err.message, err.details)
    throw err
  }
}

const services = new WeakMap<ResolvedDeps, MassDispatchService>()
function serviceFor(deps: ResolvedDeps): MassDispatchService {
  let s = services.get(deps)
  if (!s) {
    let queue: ReturnType<typeof defineQueue<MassDispatchJobData>> | undefined
    s = new MassDispatchService({
      db: deps.db,
      ...(deps.waGateway ? { waGateway: deps.waGateway } : {}),
      jobs: deps.massDispatchJobs ?? bullMassDispatchJobs(() => (queue ??= defineQueue<MassDispatchJobData>(MASS_DISPATCH_QUEUE))),
    })
    services.set(deps, s)
  }
  return s
}

const MAX_MANIFEST_BYTES = 10 * 1024 * 1024
const recipientsQuery = pageQuerySchema.extend({ status: z.enum(['pending', 'started', 'failed', 'cancelled', 'skipped']).optional() })

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('VALIDATION_ERROR', `${path} não é JSON válido`, { fields: [{ path, message: 'JSON inválido' }] })
  }
}

/** `targets[0][connection_id]`, `targets` (JSON) ou `connection_id` + `flow_id` soltos. */
function targetsOf(body: Record<string, unknown>): TargetInput[] {
  if (Array.isArray(body.targets)) return body.targets as TargetInput[]
  if (typeof body.targets === 'string' && body.targets.trim()) {
    const parsed = parseJson(body.targets, 'targets')
    if (!Array.isArray(parsed)) throw new ApiError('VALIDATION_ERROR', 'targets deve ser uma lista', { fields: [{ path: 'targets', message: 'lista esperada' }] })
    return parsed as TargetInput[]
  }
  const byIndex = new Map<number, TargetInput>()
  for (const [k, v] of Object.entries(body)) {
    const m = /^targets\[(\d+)\]\[(connection_id|flow_id)\]$/.exec(k)
    if (!m) continue
    const t = byIndex.get(Number(m[1])) ?? {}
    t[m[2] as 'connection_id' | 'flow_id'] = Array.isArray(v) ? v[0] : v
    byIndex.set(Number(m[1]), t)
  }
  if (byIndex.size) return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t)
  if (body.connection_id !== undefined || body.flow_id !== undefined) return [{ connection_id: body.connection_id, flow_id: body.flow_id }]
  return []
}

/** Corpo multipart ou JSON → entrada do serviço. */
async function createInput(c: Context<AppEnv>): Promise<CreateMassDispatchInput> {
  const type = c.req.header('content-type') ?? ''
  let body: Record<string, unknown>
  let manifest: unknown
  if (type.includes('multipart/form-data')) {
    body = (await c.req.parseBody({ all: true })) as Record<string, unknown>
    const part = Array.isArray(body.manifest) ? body.manifest[0] : body.manifest
    if (part instanceof File) {
      if (part.size > MAX_MANIFEST_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Manifesto acima de 10 MB')
      manifest = parseJson(await part.text(), 'manifest')
    } else if (typeof part === 'string') manifest = parseJson(part, 'manifest')
    const weekdays = body['weekdays[]'] ?? body.weekdays
    body = { ...body, weekdays: Array.isArray(weekdays) ? weekdays : weekdays }
  } else {
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('VALIDATION_ERROR', 'Corpo deve ser um objeto')
    if (body.mass_dispatch && typeof body.mass_dispatch === 'object' && !body.manifest) body = { ...(body.mass_dispatch as Record<string, unknown>), manifest: body.manifest }
    manifest = typeof body.manifest === 'string' ? parseJson(body.manifest, 'manifest') : body.manifest
  }
  const single = (v: unknown) => (Array.isArray(v) ? v[0] : v)
  return {
    name: single(body.name),
    targets: targetsOf(body),
    flow_b_id: single(body.flow_b_id),
    manifest,
    weekdays: body.weekdays,
    window_start: single(body.window_start),
    window_end: single(body.window_end),
    time_zone: single(body.time_zone),
    interval_min_seconds: single(body.interval_min_seconds),
    interval_max_seconds: single(body.interval_max_seconds),
    daily_limit: single(body.daily_limit),
    starts_scheduling_at: single(body.starts_scheduling_at),
  }
}

export function massDispatchRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()

  app.get('/api/mass-dispatches/quota', requirePerm('contacts.view'), async (c) => {
    const quota = await serviceFor(deps).quota(getCompanyCtx(c).companyId)
    return c.json({ mass_dispatch_quota: quota, quota })
  })

  app.get('/api/mass-dispatches', requirePerm('contacts.view'), validate('query', pageQuerySchema), async (c) => {
    const q = c.req.valid('query')
    const result = await serviceFor(deps).list(getCompanyCtx(c).companyId, { page: q.page, limit: q.limit })
    return c.json({ ...result, mass_dispatches: result.items })
  })

  app.post('/api/mass-dispatches', requirePerm('mass_dispatch.create'), async (c) => {
    const ctx = getCompanyCtx(c)
    const input = await createInput(c)
    const { massDispatch, warnings } = await run(() => serviceFor(deps).create({ companyId: ctx.companyId, userId: ctx.user?.id ?? null }, input))
    setAudit(c, { action: 'mass_dispatch.create', targetType: 'mass_dispatch', targetId: massDispatch.id, detail: { total_count: massDispatch.total_count, warnings: warnings.map((w) => w.code) } })
    return c.json({ mass_dispatch: massDispatch, warnings }, 201)
  })

  app.get('/api/mass-dispatches/:id', requirePerm('contacts.view'), async (c) => {
    const massDispatch = await run(() => serviceFor(deps).get(getCompanyCtx(c).companyId, c.req.param('id')))
    return c.json({ mass_dispatch: massDispatch })
  })

  app.get('/api/mass-dispatches/:id/recipients', requirePerm('contacts.view'), validate('query', recipientsQuery), async (c) => {
    const q = c.req.valid('query')
    const result = await run(() => serviceFor(deps).recipients(getCompanyCtx(c).companyId, c.req.param('id'), { page: q.page, limit: q.limit, ...(q.status ? { status: q.status } : {}) }))
    return c.json(result)
  })

  app.post('/api/mass-dispatches/:id/cancel', requirePerm('mass_dispatch.create'), async (c) => {
    const { massDispatch, releasedCount } = await run(() => serviceFor(deps).cancel(getCompanyCtx(c).companyId, c.req.param('id')))
    setAudit(c, { action: 'mass_dispatch.cancel', targetType: 'mass_dispatch', targetId: massDispatch.id, detail: { released_count: releasedCount } })
    return c.json({ mass_dispatch: massDispatch, released_count: releasedCount })
  })

  return app
}
