// Agentes de IA (SPEC T39; 07-agentes-ia.md §6). Leitura com flows.view; escrita e ações com flows.edit (07 §8).
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { AGENT_MEDIA_MAX_BYTES, AiAgentsError, AiAgentsService, AVATAR_MAX_BYTES, agentWriteSchema, type AiProviderKeys } from '@crm/core'
import { AI_AGENT_STATUSES } from '@crm/db'
import { FsBlobStore } from '@crm/node-kit'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Chave de provedor de IA configurada? Default: chaves da plataforma no env (T38 troca por BYOK). */
    aiProviderKeys?: AiProviderKeys
  }
}

const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'agent' in v && Object.keys(v).length === 1 ? (v as { agent: unknown }).agent : v
const writeSchema = z.preprocess((v) => unwrap(v) ?? {}, agentWriteSchema)
const listQuery = z.object({ status: z.enum(AI_AGENT_STATUSES).optional() })

function toApiError(err: unknown): unknown {
  if (!(err instanceof AiAgentsError)) return err
  const map = {
    not_found: 'NOT_FOUND',
    validation: 'VALIDATION_ERROR',
    conflict: 'CONFLICT',
    invalid_transition: 'INVALID_TRANSITION',
    limit_reached: 'LIMIT_REACHED',
    payload_too_large: 'PAYLOAD_TOO_LARGE',
    unsupported_media: 'UNSUPPORTED_MEDIA',
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

/** JSON opcional: corpo vazio (POST em branco) vira `{}`. */
async function optionalJson(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

function parseWrite(value: unknown) {
  const r = writeSchema.safeParse(value)
  if (!r.success)
    throw new ApiError('VALIDATION_ERROR', 'Dados inválidos', { fields: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
  return r.data
}

const fileLimit = (max: number, message: string) =>
  bodyLimit({
    maxSize: max + 256 * 1024,
    onError: () => {
      throw new ApiError('PAYLOAD_TOO_LARGE', message)
    },
  })

export function aiAgentsRoutes(deps: ResolvedDeps) {
  const service = new AiAgentsService({ db: deps.db, blobStore: deps.blobStore ?? new FsBlobStore(), providerKeys: deps.aiProviderKeys })
  const app = new Hono<AppEnv>()
  const view = requirePerm('flows.view')
  const edit = requirePerm('flows.edit')
  const actor = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  app.get('/api/ai-agents', view, validate('query', listQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await domain(() => service.list(companyId, c.req.valid('query'))), 200)
  })

  app.post('/api/ai-agents', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const body = parseWrite(await optionalJson(c))
    const agent = await domain(() => service.create(companyId, body, actor(c)))
    setAudit(c, { action: 'ai_agents.create', targetType: 'ai_agent', targetId: agent.id })
    return c.json({ agent }, 201)
  })

  app.get('/api/ai-agents/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ agent: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/ai-agents/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = parseWrite(await optionalJson(c))
      const agent = await domain(() => service.update(companyId, c.req.param('id'), body))
      setAudit(c, { action: 'ai_agents.update', targetType: 'ai_agent', targetId: agent.id, detail: { fields: Object.keys(body) } })
      return c.json({ agent }, 200)
    })
  }

  app.delete('/api/ai-agents/:id', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const force = ['1', 'true'].includes(c.req.query('force') ?? '')
    await domain(() => service.delete(companyId, id, { force }))
    setAudit(c, { action: 'ai_agents.delete', targetType: 'ai_agent', targetId: id, detail: { force } })
    return c.json({ ok: true }, 200)
  })

  app.post('/api/ai-agents/:id/duplicate', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const agent = await domain(() => service.duplicate(companyId, c.req.param('id'), actor(c)))
    setAudit(c, { action: 'ai_agents.duplicate', targetType: 'ai_agent', targetId: agent.id, detail: { source_id: c.req.param('id') } })
    return c.json({ agent }, 201)
  })

  for (const action of ['publish', 'pause'] as const) {
    app.post(`/api/ai-agents/:id/${action}`, edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const agent = await domain(() => service[action](companyId, c.req.param('id')))
      setAudit(c, { action: `ai_agents.${action}`, targetType: 'ai_agent', targetId: agent.id })
      return c.json({ agent }, 200)
    })
  }

  // ---------- avatar ----------

  app.post('/api/ai-agents/:id/avatar', edit, fileLimit(AVATAR_MAX_BYTES, 'Imagem acima de 5 MB'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const file = (await c.req.parseBody())['avatar']
    if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', 'Envie a imagem no campo "avatar"', { fields: [{ path: 'avatar', message: 'Obrigatório' }] })
    if (file.size > AVATAR_MAX_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Imagem acima de 5 MB')
    const agent = await domain(async () => service.setAvatar(companyId, c.req.param('id'), new Uint8Array(await file.arrayBuffer())))
    setAudit(c, { action: 'ai_agents.avatar.update', targetType: 'ai_agent', targetId: agent.id })
    return c.json({ agent }, 200)
  })

  app.delete('/api/ai-agents/:id/avatar', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const agent = await domain(() => service.removeAvatar(companyId, c.req.param('id')))
    setAudit(c, { action: 'ai_agents.avatar.delete', targetType: 'ai_agent', targetId: agent.id })
    return c.json({ agent }, 200)
  })

  app.get('/api/ai-agents/:id/avatar', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const avatar = await domain(() => service.readAvatar(companyId, c.req.param('id')))
    if (!avatar) throw new ApiError('NOT_FOUND', 'Avatar não encontrado')
    return c.body(new Uint8Array(avatar.bytes), 200, { 'Content-Type': avatar.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
  })

  // ---------- mídias enviáveis ----------

  app.post('/api/ai-agents/:id/media', edit, fileLimit(AGENT_MEDIA_MAX_BYTES, 'Arquivo acima de 8 MB'), async (c) => {
    const { companyId } = getCompanyCtx(c)
    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) throw new ApiError('VALIDATION_ERROR', 'Envie o arquivo no campo "file"', { fields: [{ path: 'file', message: 'Obrigatório' }] })
    if (file.size > AGENT_MEDIA_MAX_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Arquivo acima de 8 MB')
    const title = typeof body['title'] === 'string' ? body['title'] : undefined
    const agent = await domain(async () =>
      service.addMedia(companyId, c.req.param('id'), { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, title, filename: file.name || null }),
    )
    setAudit(c, { action: 'ai_agents.media.add', targetType: 'ai_agent', targetId: agent.id })
    return c.json({ agent }, 201)
  })

  app.delete('/api/ai-agents/:id/media/:mediaId', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const agent = await domain(() => service.removeMedia(companyId, c.req.param('id'), c.req.param('mediaId')))
    setAudit(c, { action: 'ai_agents.media.delete', targetType: 'ai_agent', targetId: agent.id, detail: { media_id: c.req.param('mediaId') } })
    return c.json({ agent }, 200)
  })

  app.get('/api/ai-agents/:id/media/:mediaId', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const media = await domain(() => service.readMedia(companyId, c.req.param('id'), c.req.param('mediaId')))
    if (!media) throw new ApiError('NOT_FOUND', 'Arquivo não encontrado')
    return c.body(new Uint8Array(media.bytes), 200, { 'Content-Type': media.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
  })

  return app
}
