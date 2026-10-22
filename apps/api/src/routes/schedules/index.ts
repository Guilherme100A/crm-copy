// Agendamentos de mensagem/fluxo (SPEC T64; 03-chats F50–F51). Permissão `chat.view` e escopo de chat (T119): chat
// fora do escopo ou de outra empresa → 404. O job de execução vai para a fila `schedules` (worker).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { SCHEDULES_QUEUE, SchedulesError, SchedulesService, defineQueue, scheduleJobId, type ChatActor, type ScheduleJobData, type ScheduleJobs } from '@crm/core'
import { SCHEDULE_STATUSES } from '@crm/db'
import { pageQuerySchema } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Fila dos jobs de agendamento (default: BullMQ `schedules` com o prefixo `CRM_QUEUE_PREFIX`). */
    scheduleJobs?: ScheduleJobs
  }
}

/** Fila BullMQ padrão, criada sob demanda (prefixo do env, como o worker). */
export function bullScheduleJobs(prefix = process.env.CRM_QUEUE_PREFIX?.trim() || undefined): ScheduleJobs {
  let queue: ReturnType<typeof defineQueue<ScheduleJobData>> | undefined
  const q = () => (queue ??= defineQueue<ScheduleJobData>(SCHEDULES_QUEUE, { ...(prefix ? { prefix } : {}), defaultJobOptions: { attempts: 1 } }))
  return {
    add: async (job, delayMs) => {
      await q().add('run', { ...job }, { jobId: scheduleJobId(job), delay: Math.max(0, delayMs), attempts: 1 })
    },
    remove: async (job) => {
      await q().remove(scheduleJobId(job))
    },
  }
}

const listQuery = pageQuerySchema.extend({ chat_id: z.uuid().optional(), status: z.enum(SCHEDULE_STATUSES).optional() })
const chatListQuery = z.object({ status: z.enum(SCHEDULE_STATUSES).optional() })

function toApiError(err: unknown): unknown {
  if (!(err instanceof SchedulesError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** Ator do escopo de chat (como na T48/T119): sessão age como o usuário; token de API pela empresa. */
function actorOf(c: Context<AppEnv>): ChatActor {
  const ctx = getCompanyCtx(c)
  return { companyId: ctx.companyId, userId: ctx.auth.kind !== 'api_token' ? (ctx.user?.id ?? null) : null, perms: ctx.perms }
}

/** Criar exige um usuário: o envio sai em nome de quem agendou. */
function authorOf(c: Context<AppEnv>): ChatActor {
  const actor = actorOf(c)
  if (!actor.userId) throw new ApiError('FORBIDDEN', 'Agendar exige um usuário (token sem usuário não agenda)')
  return actor
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

export function schedulesRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const perm = requirePerm('chat.view')
  let service: SchedulesService | undefined
  const svc = () => (service ??= new SchedulesService({ db: deps.db, jobs: deps.scheduleJobs ?? bullScheduleJobs() }))

  const create = async (c: Context<AppEnv>, chatId: string, body: Record<string, unknown>) => {
    const schedule = await domain(() => svc().create(authorOf(c), chatId, body))
    setAudit(c, { action: 'schedules.create', targetType: 'message_schedule', targetId: schedule.id, detail: { chat_id: schedule.chat_id, kind: schedule.kind, recurrence: schedule.recurrence } })
    return c.json({ schedule }, 201)
  }

  app.post('/api/chats/:id/schedules', perm, async (c) => create(c, c.req.param('id'), await jsonBody(c)))

  app.post('/api/schedules', perm, async (c) => {
    const body = await jsonBody(c)
    const chatId = typeof body.chat_id === 'string' ? body.chat_id : ''
    if (!chatId) throw new ApiError('VALIDATION_ERROR', 'Dados inválidos', { fields: [{ path: 'chat_id', message: 'Informe o chat' }] })
    return create(c, chatId, body)
  })

  app.get('/api/chats/:id/schedules', perm, validate('query', chatListQuery), async (c) => {
    const { status } = c.req.valid('query')
    const r = await domain(() => svc().list(actorOf(c), { chatId: c.req.param('id'), ...(status ? { status } : {}), page: 1, limit: 100 }))
    return c.json({ items: r.items }, 200)
  })

  app.get('/api/schedules', perm, validate('query', listQuery), async (c) => {
    const q = c.req.valid('query')
    return c.json(await domain(() => svc().list(actorOf(c), { ...(q.chat_id ? { chatId: q.chat_id } : {}), ...(q.status ? { status: q.status } : {}), page: q.page, limit: q.limit })), 200)
  })

  app.get('/api/schedules/:id', perm, async (c) => c.json({ schedule: await domain(() => svc().get(actorOf(c), c.req.param('id'))) }, 200))

  const cancel = async (c: Context<AppEnv>) => {
    const schedule = await domain(() => svc().cancel(actorOf(c), c.req.param('id')!))
    setAudit(c, { action: 'schedules.cancel', targetType: 'message_schedule', targetId: schedule.id })
    return c.json({ schedule }, 200)
  }
  app.delete('/api/schedules/:id', perm, cancel)
  app.post('/api/schedules/:id/cancel', perm, cancel)

  return app
}
