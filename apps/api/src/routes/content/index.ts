// Conteúdo (T35; 17 §3A–3C, 03 F37/F48–F49): `/api/quick-replies`, `/api/message-templates`, `/api/global-variables`,
// `/api/stickers` e `POST /api/content/render` (prévia com variáveis do contato e globais).
// Permissões: settings.quick_replies.*, settings.message_templates.*, settings.global_variables.* (sempre concedidas)
// e chat.view para figurinhas.
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ContentError, ContentService, STICKER_MAX_BYTES } from '@crm/core'
import type { ErrorCode } from '@crm/shared'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import { validate } from '../../lib/validate'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { requirePerm } from '../../middleware/authorize'
import { setAudit } from '../../middleware/audit'
import { mediaServiceFor } from '../media/index'

const KIND: Record<ContentError['kind'], ErrorCode> = {
  not_found: 'NOT_FOUND',
  validation: 'VALIDATION_ERROR',
  conflict: 'CONFLICT',
  unsupported_media: 'UNSUPPORTED_MEDIA',
  payload_too_large: 'PAYLOAD_TOO_LARGE',
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ContentError) {
      const details = err.errorCode || err.details ? { ...err.details, ...(err.errorCode ? { error_code: err.errorCode } : {}) } : undefined
      throw new ApiError(KIND[err.kind], err.message, details)
    }
    throw err
  }
}

const unwrap = (key: string) => (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && key in v && typeof (v as Record<string, unknown>)[key] === 'object'
    ? (v as Record<string, unknown>)[key]
    : v

const page = z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), search: z.string().max(200).optional() })
const action = z.object({ type: z.string().max(40), order: z.number().int().min(0).optional(), config: z.record(z.string(), z.unknown()).default({}) })
const quickReplySchema = z.preprocess(unwrap('quick_reply'), z.object({ shortcut: z.string().max(200), actions: z.array(action).max(50) }))
const quickReplyPatch = z.preprocess(unwrap('quick_reply'), z.object({ shortcut: z.string().max(200).optional(), actions: z.array(action).max(50).optional() }))
const header = z.object({ type: z.string().max(20), text: z.string().max(200).nullish(), media_id: z.string().max(2000).nullish() })
const button = z.object({ type: z.string().max(20), text: z.string().max(200), url: z.string().max(2000).nullish(), phone: z.string().max(40).nullish() })
const templateSchema = z.preprocess(
  unwrap('template'),
  z.object({ name: z.string().max(120), header: header.optional(), body: z.string().max(10_000), footer: z.string().max(200).nullish(), buttons: z.array(button).max(50).optional() }),
)
const templatePatch = z.preprocess(
  unwrap('template'),
  z.object({
    name: z.string().max(120).optional(),
    header: header.optional(),
    body: z.string().max(10_000).optional(),
    footer: z.string().max(200).nullish(),
    buttons: z.array(button).max(50).optional(),
  }),
)
const value = z.union([z.string().max(10_000), z.number()]).nullish()
const globalSchema = z.preprocess(
  unwrap('global_variable'),
  z.object({ name: z.string().max(200), description: z.string().max(2000).nullish(), type: z.string().max(20).optional(), data_type: z.string().max(20).optional(), value }),
)
const globalPatch = z.preprocess(
  unwrap('global_variable'),
  z.object({ name: z.unknown().optional(), description: z.string().max(2000).nullish(), type: z.string().max(20).optional(), data_type: z.string().max(20).optional(), value: value.optional() }),
)
const renderSchema = z.object({
  template: z.string().max(20_000).optional(),
  template_id: z.string().max(64).optional(),
  quick_reply_id: z.string().max(64).optional(),
  contact_id: z.string().max(64).nullish(),
})

export function contentRoutes(deps: ResolvedDeps) {
  const app = new Hono<AppEnv>()
  let service: ContentService | undefined
  const svc = () => (service ??= new ContentService({ db: deps.db, media: mediaServiceFor(deps) }))
  const ctxOf = (c: Context<AppEnv>) => {
    const ctx = getCompanyCtx(c)
    return { companyId: ctx.companyId, userId: ctx.auth.kind === 'session' ? (ctx.user?.id ?? null) : null }
  }
  const audit = (c: Context<AppEnv>, action: string, targetType: string, targetId: string) => setAudit(c, { action: `content.${action}`, targetType, targetId })

  // ---------------- respostas rápidas
  const qrView = requirePerm('settings.quick_replies.view')
  const qrEdit = requirePerm('settings.quick_replies.edit')
  app.get('/api/quick-replies', qrView, validate('query', page.extend({ type: z.string().max(40).optional() })), async (c) =>
    c.json(await run(() => svc().listQuickReplies(ctxOf(c).companyId, c.req.valid('query')))),
  )
  app.post('/api/quick-replies', qrEdit, validate('json', quickReplySchema), async (c) => {
    const { companyId, userId } = ctxOf(c)
    const qr = await run(() => svc().createQuickReply(companyId, userId, c.req.valid('json')))
    audit(c, 'quick_reply.create', 'quick_reply', qr.id)
    return c.json({ quick_reply: qr }, 201)
  })
  app.get('/api/quick-replies/:id', qrView, async (c) => c.json({ quick_reply: await run(() => svc().getQuickReply(ctxOf(c).companyId, c.req.param('id'))) }))
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/quick-replies/:id', qrEdit, validate('json', quickReplyPatch), async (c) => {
      const qr = await run(() => svc().updateQuickReply(ctxOf(c).companyId, c.req.param('id'), c.req.valid('json')))
      audit(c, 'quick_reply.update', 'quick_reply', qr.id)
      return c.json({ quick_reply: qr })
    })
  }
  app.delete('/api/quick-replies/:id', requirePerm('settings.quick_replies.delete'), async (c) => {
    await run(() => svc().deleteQuickReply(ctxOf(c).companyId, c.req.param('id')))
    audit(c, 'quick_reply.delete', 'quick_reply', c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ---------------- modelos internos
  const tView = requirePerm('settings.message_templates.view')
  const tEdit = requirePerm('settings.message_templates.edit')
  app.get('/api/message-templates', tView, validate('query', page), async (c) => c.json(await run(() => svc().listTemplates(ctxOf(c).companyId, c.req.valid('query')))))
  app.post('/api/message-templates', tEdit, validate('json', templateSchema), async (c) => {
    const { companyId, userId } = ctxOf(c)
    const b = c.req.valid('json')
    const template = await run(() =>
      svc().createTemplate(companyId, userId, { name: b.name, header: b.header as never, body: b.body, footer: b.footer ?? null, buttons: (b.buttons ?? []) as never }),
    )
    audit(c, 'template.create', 'message_template', template.id)
    return c.json({ template }, 201)
  })
  app.get('/api/message-templates/:id', tView, async (c) => c.json({ template: await run(() => svc().getTemplate(ctxOf(c).companyId, c.req.param('id'))) }))
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/message-templates/:id', tEdit, validate('json', templatePatch), async (c) => {
      const b = c.req.valid('json')
      const template = await run(() =>
        svc().updateTemplate(ctxOf(c).companyId, c.req.param('id'), {
          name: b.name,
          header: b.header as never,
          body: b.body,
          ...(b.footer !== undefined ? { footer: b.footer } : {}),
          buttons: b.buttons as never,
        }),
      )
      audit(c, 'template.update', 'message_template', template.id)
      return c.json({ template })
    })
  }
  app.delete('/api/message-templates/:id', requirePerm('settings.message_templates.delete'), async (c) => {
    await run(() => svc().deleteTemplate(ctxOf(c).companyId, c.req.param('id')))
    audit(c, 'template.delete', 'message_template', c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ---------------- variáveis globais
  const gView = requirePerm('settings.global_variables.view')
  const gEdit = requirePerm('settings.global_variables.edit')
  app.get('/api/global-variables', gView, validate('query', page), async (c) => c.json(await run(() => svc().listGlobals(ctxOf(c).companyId, c.req.valid('query')))))
  app.post('/api/global-variables', gEdit, validate('json', globalSchema), async (c) => {
    const b = c.req.valid('json')
    const variable = await run(() => svc().createGlobal(ctxOf(c).companyId, { name: b.name, description: b.description, type: b.type ?? b.data_type, value: b.value }))
    audit(c, 'global_variable.create', 'global_variable', variable.id)
    return c.json({ global_variable: variable }, 201)
  })
  app.get('/api/global-variables/:id', gView, async (c) => c.json({ global_variable: await run(() => svc().getGlobal(ctxOf(c).companyId, c.req.param('id'))) }))
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/global-variables/:id', gEdit, validate('json', globalPatch), async (c) => {
      const b = c.req.valid('json')
      const variable = await run(() =>
        svc().updateGlobal(ctxOf(c).companyId, c.req.param('id'), { name: b.name, description: b.description, type: b.type ?? b.data_type, value: b.value }),
      )
      audit(c, 'global_variable.update', 'global_variable', variable.id)
      return c.json({ global_variable: variable })
    })
  }
  app.delete('/api/global-variables/:id', requirePerm('settings.global_variables.delete'), async (c) => {
    await run(() => svc().deleteGlobal(ctxOf(c).companyId, c.req.param('id')))
    audit(c, 'global_variable.delete', 'global_variable', c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ---------------- figurinhas
  const chat = requirePerm('chat.view')
  const limitSticker = bodyLimit({
    maxSize: STICKER_MAX_BYTES + 64 * 1024,
    onError: () => {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Figurinha acima de 100 KB', { error_code: 'sticker_too_large', limit: STICKER_MAX_BYTES })
    },
  })
  app.get('/api/stickers', chat, validate('query', z.object({ favorites: z.enum(['1', '0', 'true', 'false']).optional() })), async (c) => {
    const { companyId, userId } = ctxOf(c)
    return c.json({ items: await run(() => svc().listStickers(companyId, userId, { favorites: ['1', 'true'].includes(c.req.valid('query').favorites ?? '') })) })
  })
  app.post('/api/stickers', chat, limitSticker, async (c) => {
    const { companyId, userId } = ctxOf(c)
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', 'Envie o arquivo no campo "file"', { fields: [{ path: 'file', message: 'Arquivo obrigatório' }] })
    const sticker = await run(async () =>
      svc().uploadSticker(companyId, userId, {
        data: new Uint8Array(await file.arrayBuffer()),
        mime: file.type || 'application/octet-stream',
        name: typeof body.name === 'string' ? body.name : null,
        fileName: file.name || null,
      }),
    )
    audit(c, 'sticker.create', 'sticker', sticker.id)
    return c.json({ sticker }, 201)
  })
  app.delete('/api/stickers/:id', chat, async (c) => {
    await run(() => svc().deleteSticker(ctxOf(c).companyId, c.req.param('id')))
    audit(c, 'sticker.delete', 'sticker', c.req.param('id'))
    return c.json({ deleted: true })
  })
  for (const [method, favorite] of [
    ['post', true],
    ['delete', false],
  ] as const) {
    app[method]('/api/stickers/:id/favorite', chat, async (c) => {
      const { companyId, userId } = ctxOf(c)
      if (!userId) throw new ApiError('FORBIDDEN', 'Favoritas são por usuário (sessão)')
      const sticker = await run(() => svc().setFavorite(companyId, userId, c.req.param('id'), favorite))
      setAudit(c, { skip: true })
      return c.json({ sticker })
    })
  }

  // ---------------- prévia
  app.post('/api/content/render', validate('json', renderSchema), async (c) => {
    const b = c.req.valid('json')
    const out = await run(() => svc().preview(ctxOf(c).companyId, { template: b.template, templateId: b.template_id, quickReplyId: b.quick_reply_id, contactId: b.contact_id }))
    setAudit(c, { skip: true })
    return c.json(out)
  })

  return app
}
