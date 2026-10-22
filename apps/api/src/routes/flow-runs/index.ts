// Execuções de fluxo (T43; 06 §5.5): disparo manual pelo chat, listagem, detalhe com passos, cancelamento e
// "cancelar todos" de uma conexão. Disparar/cancelar exige `flows.run`; ler, `flows.view`. Funil por bloco
// (`GET /api/flows/:id/funnel?from&to&connection_id`, padrão últimos 30 dias) em `funnel.ts`.
import { Hono, type Context } from 'hono'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { CANCELLABLE_RUN_STATUSES, FlowEngineError, FlowStore, FlowStoreError } from '@crm/core'
import { FLOW_RUN_STATUSES, chats, flowRunSteps, flowRuns, flows } from '@crm/db'
import { buildPageMeta, pageOffset, pageQuerySchema } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { flowFunnel } from './funnel'
import { flowServices } from './services'

export { flowServices, registerConnectionNameSource, type ConnectionNameSource, type FlowServices } from './services'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RunRow = typeof flowRuns.$inferSelect

export function toRunDto(r: RunRow, flowName: string | null = null) {
  return {
    id: r.id,
    flow_id: r.flowId,
    flow_name: flowName,
    version: r.version,
    contact_id: r.contactId,
    chat_id: r.chatId,
    status: r.status,
    current_node_key: r.currentNodeKey,
    error: r.error,
    trigger: r.trigger,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt?.toISOString() ?? null,
  }
}

const triggerSchema = z.object({ chat_id: z.uuid() })
const runsQuery = pageQuerySchema.extend({ status: z.enum(FLOW_RUN_STATUSES).optional() })
const chatRunsQuery = z.object({ active: z.enum(['1', '0', 'true', 'false']).optional() })
const cancelAllSchema = z.object({ confirmation_name: z.string().max(200) })
const funnelQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  connection_id: z.uuid().optional(),
})
const FUNNEL_DEFAULT_DAYS = 30
const FUNNEL_MAX_DAYS = 366

export function flowRunsRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const store = new FlowStore(deps.db)
  const svc = () => flowServices(deps)

  const runsWithName = (where: ReturnType<typeof and>) =>
    deps.db
      .select({ run: flowRuns, flowName: flows.name })
      .from(flowRuns)
      .innerJoin(flows, eq(flows.id, flowRuns.flowId))
      .where(where)

  const runOf = async (companyId: string, id: string) => {
    if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Execução não encontrada')
    const [row] = await runsWithName(and(eq(flowRuns.id, id), eq(flowRuns.companyId, companyId)))
    if (!row) throw new ApiError('NOT_FOUND', 'Execução não encontrada')
    return row
  }

  const publish = (companyId: string, type: 'flow_run.created' | 'flow_run.cancelled', r: RunRow) =>
    svc()
      .publisher.publish(companyId, type, { run_id: r.id, flow_id: r.flowId, contact_id: r.contactId, chat_id: r.chatId, status: r.status })
      .catch(() => undefined)

  /** Cancela os runs (via FlowControl, que remove os timers) e publica `flow_run.cancelled`. */
  const cancelRuns = async (companyId: string, ids: string[]) => {
    const done: string[] = []
    for (const id of ids) if ((await svc().control.cancel(id)).cancelled) done.push(id)
    if (done.length) {
      const rows = await deps.db.select().from(flowRuns).where(inArray(flowRuns.id, done))
      for (const r of rows) await publish(companyId, 'flow_run.cancelled', r)
    }
    return done
  }

  const ctxOf = (c: Context<AppEnv>) => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.user?.id ?? null }
  }

  // Disparo manual pelo chat: cancela o run ativo do contato e inicia o fluxo ativo.
  app.post('/api/flows/:id/trigger', requirePerm('flows.run'), validate('json', triggerSchema), async (c) => {
    const ctx = ctxOf(c)
    const flow = await store.getFlow(ctx, c.req.param('id')).catch((err: unknown) => {
      if (err instanceof FlowStoreError) throw new ApiError('NOT_FOUND', 'Fluxo não encontrado')
      throw err
    })
    if (flow.status !== 'active' || !flow.publishedVersion) throw new ApiError('CONFLICT', 'O fluxo não está ativo', { error_code: 'flow_not_active' })
    const [chat] = await deps.db
      .select({ id: chats.id, contactId: chats.contactId })
      .from(chats)
      .where(and(eq(chats.id, c.req.valid('json').chat_id), eq(chats.companyId, ctx.companyId)))
      .limit(1)
    if (!chat) throw new ApiError('NOT_FOUND', 'Chat não encontrado')

    const active = await deps.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .where(and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.contactId, chat.contactId), inArray(flowRuns.status, [...CANCELLABLE_RUN_STATUSES])))
    const cancelled = await cancelRuns(ctx.companyId, active.map((r) => r.id))

    let runId: string
    try {
      runId = (
        await svc().engine.startRun(ctx, {
          flowId: flow.id,
          contactId: chat.contactId,
          chatId: chat.id,
          trigger: { kind: 'manual', user_id: ctx.userId, chat_id: chat.id },
        })
      ).runId
    } catch (err) {
      if (err instanceof FlowEngineError) {
        if (err.code === 'contact_not_found' || err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
        throw new ApiError('CONFLICT', err.message, { error_code: err.code === 'run_active' ? 'run_active' : 'flow_not_active' })
      }
      throw err
    }
    await svc().enqueue({ runId, expectedSeq: 0 })
    const { run } = await runOf(ctx.companyId, runId)
    await publish(ctx.companyId, 'flow_run.created', run)
    setAudit(c, { action: 'flow_run.trigger', targetType: 'flow_run', targetId: run.id, detail: { flow_id: flow.id, chat_id: chat.id } })
    return c.json({ run: toRunDto(run, flow.name), cancelled_run_ids: cancelled }, 201)
  })

  app.get('/api/flows/:id/runs', requirePerm('flows.view'), validate('query', runsQuery), async (c) => {
    const ctx = ctxOf(c)
    const flow = await store.getFlow(ctx, c.req.param('id')).catch((err: unknown) => {
      if (err instanceof FlowStoreError) throw new ApiError('NOT_FOUND', 'Fluxo não encontrado')
      throw err
    })
    const q = c.req.valid('query')
    const where = and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.flowId, flow.id), q.status ? eq(flowRuns.status, q.status) : undefined)
    const [total] = await deps.db.select({ n: count() }).from(flowRuns).where(where)
    const rows = await runsWithName(where).orderBy(desc(flowRuns.startedAt)).limit(q.limit).offset(pageOffset(q))
    return c.json({ items: rows.map((r) => toRunDto(r.run, r.flowName)), page: buildPageMeta(q, { total: Number(total?.n ?? 0) }) })
  })

  app.get('/api/flows/:id/funnel', requirePerm('flows.view'), validate('query', funnelQuery), async (c) => {
    const ctx = ctxOf(c)
    const flow = await store.getFlow(ctx, c.req.param('id')).catch((err: unknown) => {
      if (err instanceof FlowStoreError) throw new ApiError('NOT_FOUND', 'Fluxo não encontrado')
      throw err
    })
    const q = c.req.valid('query')
    const to = q.to ? new Date(q.to) : new Date()
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - FUNNEL_DEFAULT_DAYS * 86_400_000)
    if (from.getTime() > to.getTime())
      throw new ApiError('VALIDATION_ERROR', 'Período inválido', { fields: [{ path: 'from', message: 'from precisa ser antes de to' }] })
    if (to.getTime() - from.getTime() > FUNNEL_MAX_DAYS * 86_400_000)
      throw new ApiError('VALIDATION_ERROR', 'Período inválido', { fields: [{ path: 'from', message: `no máximo ${FUNNEL_MAX_DAYS} dias` }] })
    const def = await store.toDefinition(ctx, flow.id)
    return c.json({ funnel: await flowFunnel(deps.db, ctx.companyId, flow.id, def, { from, to, ...(q.connection_id ? { connectionId: q.connection_id } : {}) }) })
  })

  app.get('/api/flow-runs/:id', requirePerm('flows.view'), async (c) => {
    const ctx = ctxOf(c)
    const { run, flowName } = await runOf(ctx.companyId, c.req.param('id'))
    const steps = await deps.db
      .select()
      .from(flowRunSteps)
      .where(and(eq(flowRunSteps.runId, run.id), eq(flowRunSteps.companyId, ctx.companyId)))
      .orderBy(asc(flowRunSteps.seq), sql`${flowRunSteps.actionKey} nulls first`)
    return c.json({
      run: toRunDto(run, flowName),
      steps: steps.map((s) => ({
        seq: s.seq,
        node_key: s.nodeKey,
        action_key: s.actionKey,
        status: s.status,
        result: s.result,
        error: s.error,
        created_at: s.createdAt.toISOString(),
      })),
    })
  })

  app.post('/api/flow-runs/:id/cancel', requirePerm('flows.run'), async (c) => {
    const ctx = ctxOf(c)
    const { run } = await runOf(ctx.companyId, c.req.param('id'))
    const done = await cancelRuns(ctx.companyId, [run.id])
    if (!done.length) throw new ApiError('CONFLICT', 'A execução já terminou', { error_code: 'run_not_active' })
    const after = await runOf(ctx.companyId, run.id)
    setAudit(c, { action: 'flow_run.cancel', targetType: 'flow_run', targetId: run.id })
    return c.json({ run: toRunDto(after.run, after.flowName) })
  })

  app.get('/api/chats/:id/flow-runs', requirePerm('flows.view'), validate('query', chatRunsQuery), async (c) => {
    const ctx = ctxOf(c)
    const id = c.req.param('id')
    if (!UUID_RE.test(id)) throw new ApiError('NOT_FOUND', 'Chat não encontrado')
    const [chat] = await deps.db.select({ id: chats.id }).from(chats).where(and(eq(chats.id, id), eq(chats.companyId, ctx.companyId))).limit(1)
    if (!chat) throw new ApiError('NOT_FOUND', 'Chat não encontrado')
    const activeOnly = ['1', 'true'].includes(c.req.valid('query').active ?? '')
    const rows = await runsWithName(
      and(eq(flowRuns.companyId, ctx.companyId), eq(flowRuns.chatId, chat.id), activeOnly ? inArray(flowRuns.status, [...CANCELLABLE_RUN_STATUSES]) : undefined),
    ).orderBy(desc(flowRuns.startedAt))
    return c.json({ items: rows.map((r) => toRunDto(r.run, r.flowName)) })
  })

  /** Cancela todos os runs ativos da conexão; exige digitar o nome exato da conexão (06 §5.5). */
  app.post('/api/connections/:id/cancel-all-flow-runs', requirePerm('flows.run'), validate('json', cancelAllSchema), async (c) => {
    const ctx = ctxOf(c)
    const connectionId = c.req.param('id')
    if (!UUID_RE.test(connectionId)) throw new ApiError('NOT_FOUND', 'Conexão não encontrada')
    const name = await svc().connectionName(ctx, connectionId)
    if (name === null) throw new ApiError('NOT_FOUND', 'Conexão não encontrada')
    if (c.req.valid('json').confirmation_name !== name)
      throw new ApiError('VALIDATION_ERROR', 'Digite o nome exato da conexão para confirmar', {
        error_code: 'confirmation_mismatch',
        fields: [{ path: 'confirmation_name', message: 'nome da conexão não confere' }],
      })
    const runs = await deps.db
      .select({ id: flowRuns.id })
      .from(flowRuns)
      .innerJoin(chats, eq(chats.id, flowRuns.chatId))
      .where(and(eq(flowRuns.companyId, ctx.companyId), eq(chats.connectionId, connectionId), inArray(flowRuns.status, [...CANCELLABLE_RUN_STATUSES])))
    const done = await cancelRuns(ctx.companyId, runs.map((r) => r.id))
    setAudit(c, { action: 'flow_run.cancel_all', targetType: 'connection', targetId: connectionId, detail: { cancelled: done.length } })
    return c.json({ cancelled: done.length })
  })

  return app
}
