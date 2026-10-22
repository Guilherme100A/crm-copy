// Kanban (T50; 04 §6): `/api/crms` (quadros), `/api/crms/:id/columns` e `/api/crms/:id/cards`, com totais por coluna,
// chats disponíveis e funil. Ler: `kanban.view`; criar/editar/mover: `kanban.edit`; excluir: `kanban.delete`.
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { KanbanError, KanbanService, RealtimePublisher, type CardFilters, type ChatActor, type KanbanErrorKind } from '@crm/core'
import type { ErrorCode } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'

const KIND: Record<KanbanErrorKind, ErrorCode> = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT' }

export function kanbanToApi(err: unknown): unknown {
  if (!(err instanceof KanbanError)) return err
  const details = err.errorCode || err.details ? { ...err.details, ...(err.errorCode ? { error_code: err.errorCode } : {}) } : undefined
  return new ApiError(KIND[err.kind], err.message, details)
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw kanbanToApi(err)
  }
}

const services = new WeakMap<ResolvedDeps, KanbanService>()

/** Um KanbanService por app (também usado por `PATCH /api/chats/:id`). */
export function kanbanServiceFor(deps: ResolvedDeps): KanbanService {
  let s = services.get(deps)
  if (!s) {
    s = new KanbanService({
      db: deps.db,
      publisher: deps.realtimePublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
      logger: deps.logger,
    })
    services.set(deps, s)
  }
  return s
}

const unwrap = (key: string) => (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && key in v && typeof (v as Record<string, unknown>)[key] === 'object'
    ? (v as Record<string, unknown>)[key]
    : v

const name = z.string().max(200)
const color = z.string().max(16).nullable()
const boardSchema = z.preprocess(unwrap('crm'), z.object({ name }))
const boardPatchSchema = z.preprocess(unwrap('crm'), z.object({ name: name.optional() }))
const columnSchema = z.preprocess(unwrap('crm_column'), z.object({ name, accent_color: color.optional(), conversion_goal: z.boolean().optional() }))
const columnPatchSchema = z.preprocess(
  unwrap('crm_column'),
  z.object({ name: name.optional(), accent_color: color.optional(), conversion_goal: z.boolean().optional() }),
)
const columnMoveSchema = z.object({ position: z.number().int().min(0) })
const cardSchema = z.object({
  chat_id: z.string().max(64),
  column_id: z.string().max(64).nullish(),
  crm_column_id: z.string().max(64).nullish(),
  value_cents: z.number().int().min(0).optional(),
})
const cardPatchSchema = z.preprocess(unwrap('crm_card'), z.object({ value_cents: z.number().int().min(0).optional(), currency: z.string().max(3).optional() }))
const cardMoveSchema = z
  .object({ column_id: z.string().max(64).optional(), new_column_id: z.string().max(64).optional(), before_card_id: z.string().max(64).nullish() })
  .refine((b) => !!(b.column_id ?? b.new_column_id), { message: 'Informe column_id', path: ['column_id'] })
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(120).optional(),
  per_page: z.coerce.number().int().min(1).max(120).optional(),
})
const availableQuery = pageQuery.extend({ search: z.string().max(200).optional() })

/** Filtros dos cards: escalares + `label_ids` (`?label_ids=a&label_ids=b`, `?label_ids[]=a` ou `a,b`). */
function readFilters(c: Context<AppEnv>): CardFilters & { page?: number; limit?: number } {
  const one = (k: string) => c.req.query(k) || undefined
  const labels = [...(c.req.queries('label_ids') ?? []), ...(c.req.queries('label_ids[]') ?? [])]
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean)
  const paging = pageQuery.safeParse({ page: one('page'), limit: one('limit'), per_page: one('per_page') })
  if (!paging.success) throw new ApiError('VALIDATION_ERROR', 'Paginação inválida', { fields: paging.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) })
  return {
    column_id: one('column_id') ?? one('crm_column_id'),
    label_ids: labels.length ? [...new Set(labels)] : undefined,
    assigned_to: one('assigned_to'),
    updated_from: one('updated_from'),
    updated_to: one('updated_to'),
    page: paging.data.page,
    limit: paging.data.limit ?? paging.data.per_page,
  }
}

export function kanbanRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  const svc = () => kanbanServiceFor(deps)
  const view = requirePerm('kanban.view')
  const edit = requirePerm('kanban.edit')
  const del = requirePerm('kanban.delete')

  const actorOf = (c: Context<AppEnv>): ChatActor => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.auth.kind !== 'api_token' ? (ctx.user?.id ?? null) : null, perms: ctx.perms }
  }
  const audit = (c: Context<AppEnv>, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>) =>
    setAudit(c, { action: `kanban.${action}`, targetType, targetId, ...(detail ? { detail } : {}) })

  // ---------------- quadros
  app.get('/api/crms', view, async (c) => c.json({ items: await run(() => svc().listBoards(actorOf(c))) }))
  app.post('/api/crms', edit, validate('json', boardSchema), async (c) => {
    const crm = await run(() => svc().createBoard(actorOf(c), c.req.valid('json')))
    audit(c, 'crm.create', 'crm', crm.id)
    return c.json({ crm }, 201)
  })
  app.get('/api/crms/:id', view, async (c) => c.json({ crm: await run(() => svc().getBoard(actorOf(c), c.req.param('id'))) }))
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/crms/:id', edit, validate('json', boardPatchSchema), async (c) => {
      const crm = await run(() => svc().updateBoard(actorOf(c), c.req.param('id'), c.req.valid('json')))
      audit(c, 'crm.update', 'crm', crm.id)
      return c.json({ crm })
    })
  }
  app.delete('/api/crms/:id', del, async (c) => {
    const id = c.req.param('id')
    await run(() => svc().deleteBoard(actorOf(c), id))
    audit(c, 'crm.delete', 'crm', id)
    return c.json({ deleted: true })
  })

  // ---------------- colunas
  app.get('/api/crms/:id/columns', view, async (c) => c.json({ items: (await run(() => svc().getBoard(actorOf(c), c.req.param('id')))).columns }))
  app.post('/api/crms/:id/columns', edit, validate('json', columnSchema), async (c) => {
    const b = c.req.valid('json')
    const column = await run(() => svc().createColumn(actorOf(c), c.req.param('id'), { name: b.name, accentColor: b.accent_color, conversionGoal: b.conversion_goal }))
    audit(c, 'column.create', 'crm_column', column.id)
    return c.json({ column }, 201)
  })
  app.patch('/api/crms/:id/columns/:col/move', edit, validate('json', columnMoveSchema), async (c) => {
    const columns = await run(() => svc().moveColumn(actorOf(c), c.req.param('id'), c.req.param('col'), c.req.valid('json').position))
    audit(c, 'column.move', 'crm_column', c.req.param('col'))
    return c.json({ columns })
  })
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/crms/:id/columns/:col', edit, validate('json', columnPatchSchema), async (c) => {
      const b = c.req.valid('json')
      const column = await run(() =>
        svc().updateColumn(actorOf(c), c.req.param('id'), c.req.param('col'), { name: b.name, accentColor: b.accent_color, conversionGoal: b.conversion_goal }),
      )
      audit(c, 'column.update', 'crm_column', column.id)
      return c.json({ column })
    })
  }
  app.delete('/api/crms/:id/columns/:col', del, async (c) => {
    const r = await run(() => svc().deleteColumn(actorOf(c), c.req.param('id'), c.req.param('col')))
    audit(c, 'column.delete', 'crm_column', c.req.param('col'), { deleted_cards: r.deletedCards })
    return c.json({ deleted: true, deleted_cards: r.deletedCards })
  })

  // ---------------- cards (rotas fixas antes de `:card`)
  app.get('/api/crms/:id/cards', view, async (c) => c.json(await run(() => svc().listCards(actorOf(c), c.req.param('id'), readFilters(c)))))
  app.get('/api/crms/:id/available-chats', view, validate('query', availableQuery), async (c) => {
    const q = c.req.valid('query')
    return c.json(await run(() => svc().availableChats(actorOf(c), c.req.param('id'), { search: q.search, page: q.page, limit: q.limit ?? q.per_page })))
  })
  app.get('/api/crms/:id/stats', view, async (c) => c.json(await run(() => svc().stats(actorOf(c), c.req.param('id'), readFilters(c)))))
  app.post('/api/crms/:id/cards', edit, validate('json', cardSchema), async (c) => {
    const b = c.req.valid('json')
    const card = await run(() =>
      svc().createCard(actorOf(c), c.req.param('id'), { chatId: b.chat_id, columnId: b.column_id ?? b.crm_column_id ?? null, valueCents: b.value_cents }),
    )
    audit(c, 'card.create', 'crm_card', card.id, { chat_id: card.chat_id })
    return c.json({ card }, 201)
  })
  app.get('/api/crms/:id/cards/:card', view, async (c) => c.json({ card: await run(() => svc().getCard(actorOf(c), c.req.param('id'), c.req.param('card'))) }))
  app.patch('/api/crms/:id/cards/:card/move', edit, validate('json', cardMoveSchema), async (c) => {
    const b = c.req.valid('json')
    const actor = actorOf(c)
    const card = await run(() => svc().moveCard(actor, c.req.param('id'), c.req.param('card'), { columnId: (b.column_id ?? b.new_column_id)!, beforeCardId: b.before_card_id }))
    audit(c, 'card.move', 'crm_card', card.id, { column_id: card.column_id })
    return c.json({ card, columns: await run(() => svc().totals(actor, c.req.param('id'))) })
  })
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/crms/:id/cards/:card', edit, validate('json', cardPatchSchema), async (c) => {
      const b = c.req.valid('json')
      const card = await run(() => svc().updateCard(actorOf(c), c.req.param('id'), c.req.param('card'), { valueCents: b.value_cents, currency: b.currency }))
      audit(c, 'card.update', 'crm_card', card.id)
      return c.json({ card })
    })
  }
  app.delete('/api/crms/:id/cards/:card', del, async (c) => {
    await run(() => svc().deleteCard(actorOf(c), c.req.param('id'), c.req.param('card')))
    audit(c, 'card.delete', 'crm_card', c.req.param('card'))
    return c.json({ deleted: true })
  })

  return app
}
