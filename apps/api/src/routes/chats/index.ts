// Chats: lista, filtros, escopo e ciclo de vida (SPEC T48; 03 F01–F22, F52–F57). Tudo exige chat.view;
// bloquear chat.block, excluir chat.delete; atribuir a outro/tirar de outro chat.assign_others (no serviço).
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { ChatLifecycleService, ChatsError, RealtimePublisher, type ChatActor, type ChatListQuery } from '@crm/core'
import { CHAT_STATUSES } from '@crm/db'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'
import { kanbanServiceFor, kanbanToApi } from '../kanban/index'

function toApiError(err: unknown): unknown {
  if (!(err instanceof ChatsError)) return err
  const code = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', invalid_transition: 'INVALID_TRANSITION', forbidden: 'FORBIDDEN' } as const
  return new ApiError(code[err.code], err.message, err.details)
}

/** Erros do Kanban (T50) no PATCH de quadro/coluna. */
async function kanban<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw kanbanToApi(err)
  }
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

const uuid = z.uuid()
const listQuery = z.object({
  status: z.enum(CHAT_STATUSES).optional(),
  search: z.string().max(200).optional(),
  assigned_to: z.union([z.literal('me'), z.literal('none'), uuid]).optional(),
  response_status: z.enum(['unanswered', 'answered']).optional(),
  read_status: z.enum(['unread', 'read']).optional(),
  created_from: z.string().max(40).optional(),
  created_to: z.string().max(40).optional(),
  contact_id: uuid.optional(),
  // T50: chats com card no quadro/coluna do Kanban.
  crm_id: uuid.optional(),
  crm_column_id: uuid.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})
const LIST_PARAMS = ['connection_ids', 'department_ids', 'label_ids'] as const

/** Query da lista: escalares validados por zod; listas aceitam `?x=a&x=b`, `?x[]=a` e `?x=a,b`. */
function readListQuery(c: Context<AppEnv>): ChatListQuery {
  const single: Record<string, string> = {}
  for (const [k, v] of Object.entries(c.req.queries())) if (!k.endsWith('[]') && !(LIST_PARAMS as readonly string[]).includes(k) && v.length) single[k] = v[0]!
  const parsed = listQuery.safeParse(single)
  if (!parsed.success)
    throw new ApiError('VALIDATION_ERROR', 'Filtros inválidos', { fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  const q: ChatListQuery = { ...parsed.data }
  for (const name of LIST_PARAMS) {
    const raw = [...(c.req.queries(name) ?? []), ...(c.req.queries(`${name}[]`) ?? [])].flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
    if (!raw.length) continue
    const bad = raw.findIndex((v) => !uuid.safeParse(v).success)
    if (bad >= 0) throw new ApiError('VALIDATION_ERROR', 'Filtro inválido', { fields: [{ path: `${name}.${bad}`, message: 'uuid inválido' }] })
    q[name] = [...new Set(raw)]
  }
  return q
}

const openSchema = z.object({ contact_id: z.string().max(64), connection_id: z.string().max(64) })
const assignSchema = z.object({ user_id: z.string().max(64).nullish() })
const patchSchema = z
  .object({
    department_id: z.string().max(64).nullable().optional(),
    ai_agent_id: z.string().max(64).nullable().optional(),
    // T50: quadro/coluna do Kanban (cria/move o card; `crm_column_id: null` tira do quadro). Exige kanban.edit.
    crm_id: z.string().max(64).optional(),
    crm_column_id: z.string().max(64).nullable().optional(),
  })
  .strict()
const noteSchema = z.object({ body: z.string().max(20_000) })
const labelSchema = z.object({ label_id: z.string().max(64) })

export function chatsRoutes(deps: ResolvedDeps) {
  const service = new ChatLifecycleService({
    db: deps.db,
    publisher: deps.chatPublisher ?? new RealtimePublisher({ redis: deps.redis, prefix: deps.realtime?.prefix }),
  })
  const query = service.query
  const app = new Hono<AppEnv>()
  const view = requirePerm('chat.view')

  /** Token de API age pela empresa inteira (sem "eu"); sessão age como o usuário. */
  const actorOf = (c: Context<AppEnv>): ChatActor => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.auth.kind === 'session' ? (ctx.user?.id ?? null) : null, perms: ctx.perms }
  }
  const audit = (c: Context<AppEnv>, action: string, chatId: string, detail?: Record<string, unknown>) =>
    setAudit(c, { action: `chats.${action}`, targetType: 'chat', targetId: chatId, ...(detail ? { detail } : {}) })

  app.get('/api/chats', view, async (c) => c.json(await domain(() => query.list(actorOf(c), readListQuery(c))), 200))
  app.get('/api/chats/counts', view, async (c) => c.json({ counts: await domain(() => query.counts(actorOf(c), readListQuery(c))) }, 200))
  app.get('/api/chats/filter-options', view, async (c) => c.json(await domain(() => query.filterOptions(actorOf(c))), 200))

  app.post('/api/chats', view, validate('json', openSchema), async (c) => {
    const res = await domain(() => service.open(actorOf(c), c.req.valid('json')))
    if (res.created) audit(c, 'create', res.chat.id)
    return c.json(res, res.created ? 201 : 200)
  })

  app.post('/api/chats/mark-all-read', view, async (c) => {
    const updated = await domain(() => query.markAllRead(actorOf(c), readListQuery(c)))
    setAudit(c, { action: 'chats.mark_all_read', targetType: 'chat', detail: { updated } })
    return c.json({ updated }, 200)
  })

  app.get('/api/chats/:id', view, async (c) => c.json({ chat: await domain(() => query.get(actorOf(c), c.req.param('id'))) }, 200))

  app.patch('/api/chats/:id', view, validate('json', patchSchema), async (c) => {
    const { crm_id, crm_column_id, ...body } = c.req.valid('json')
    const actor = actorOf(c)
    const id = c.req.param('id')
    // T50: quadro/coluna do Kanban — o chat precisa estar no escopo (ChatQueryService.row → 404 fora dele).
    let card: unknown = undefined
    if (crm_id !== undefined || crm_column_id !== undefined) {
      if (crm_id === undefined)
        throw new ApiError('VALIDATION_ERROR', 'Informe crm_id junto com crm_column_id', { fields: [{ path: 'crm_id', message: 'obrigatório com crm_column_id' }] })
      if (!(getCompanyCtx(c).perms as ReadonlySet<string>).has('kanban.edit')) throw new ApiError('FORBIDDEN', 'Permissão insuficiente', { permission: 'kanban.edit' })
      await domain(() => query.row(actor, id))
      card = await kanban(() => kanbanServiceFor(deps).setChatColumn(actor, id, crm_id, crm_column_id))
    }
    const chat = Object.keys(body).length ? await domain(() => service.update(actor, id, body)) : await domain(() => query.get(actor, id))
    audit(c, 'update', chat.id, { fields: [...Object.keys(body), ...(card !== undefined ? ['crm_id', 'crm_column_id'] : [])] })
    return c.json(card !== undefined ? { chat, card } : { chat }, 200)
  })

  app.delete('/api/chats/:id', requirePerm('chat.delete'), async (c) => {
    const id = c.req.param('id')
    await domain(() => service.delete(actorOf(c), id))
    audit(c, 'delete', id)
    return c.json({ ok: true }, 200)
  })

  for (const method of ['patch', 'post'] as const) {
    app[method]('/api/chats/:id/assign', view, validate('json', assignSchema), async (c) => {
      const chat = await domain(() => service.assign(actorOf(c), c.req.param('id'), c.req.valid('json')))
      audit(c, 'assign', chat.id, { user_id: chat.assigned_user_id })
      return c.json({ chat }, 200)
    })
  }

  for (const action of ['unassign', 'resolve', 'reopen'] as const) {
    app.post(`/api/chats/:id/${action}`, view, async (c) => {
      const chat = await domain(() => service[action](actorOf(c), c.req.param('id')))
      audit(c, action, chat.id)
      return c.json({ chat }, 200)
    })
  }

  for (const [action, blocked] of [
    ['block', true],
    ['unblock', false],
  ] as const) {
    app.post(`/api/chats/:id/${action}`, view, requirePerm('chat.block'), async (c) => {
      const chat = await domain(() => service.block(actorOf(c), c.req.param('id'), blocked))
      audit(c, action, chat.id)
      return c.json({ chat }, 200)
    })
  }

  // ---------- notas, linha do tempo e etiquetas ----------

  app.get('/api/chats/:id/notes', view, async (c) => c.json({ items: await domain(() => service.listNotes(actorOf(c), c.req.param('id'))) }, 200))

  app.post('/api/chats/:id/notes', view, validate('json', noteSchema), async (c) => {
    const note = await domain(() => service.addNote(actorOf(c), c.req.param('id'), c.req.valid('json').body))
    audit(c, 'note.create', note.chat_id, { note_id: note.id })
    return c.json({ note }, 201)
  })

  app.get('/api/chats/:id/events', view, async (c) => c.json({ items: await domain(() => service.listEvents(actorOf(c), c.req.param('id'))) }, 200))

  app.post('/api/chats/:id/labels', view, validate('json', labelSchema), async (c) => {
    const { label_id } = c.req.valid('json')
    const chat = await domain(() => service.addLabel(actorOf(c), c.req.param('id'), label_id))
    audit(c, 'label.add', chat.id, { label_id })
    return c.json({ chat }, 200)
  })

  app.delete('/api/chats/:id/labels/:labelId', view, async (c) => {
    const labelId = c.req.param('labelId')
    const chat = await domain(() => service.removeLabel(actorOf(c), c.req.param('id'), labelId))
    audit(c, 'label.remove', chat.id, { label_id: labelId })
    return c.json({ chat }, 200)
  })

  return app
}
