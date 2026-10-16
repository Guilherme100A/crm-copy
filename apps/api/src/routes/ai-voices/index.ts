// Vozes da conta (SPEC T80; 07 §3.7, §6). Ler: `flows.view`; criar/prévia/manter/excluir: `flows.edit` (as mesmas
// dos agentes, T39). Criação multipart: `name`, `language` e 1–3 arquivos em `audios` (ou `audios[]`). A prévia
// devolve o áudio binário (`audio/mpeg`) e é medida (`feature = 'tts'`).
import { AiVoicesError, AiVoicesService, UsageGuard, VOICE_MAX_SAMPLES, VOICE_SAMPLE_MAX_BYTES, type VoiceProviderFactory, type VoiceSampleInput } from '@crm/core'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** `fetch` da ElevenLabs (clonagem, exclusão e TTS da prévia). Default: global; base em `ELEVENLABS_API_URL`. */
    aiVoicesFetch?: typeof globalThis.fetch
    /** Provedor de voz por chave (testes). Default: ElevenLabs por HTTP. */
    aiVoicesProvider?: VoiceProviderFactory
  }
}

const listQuery = z.object({ page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
const previewBody = z.object({ text: z.string().max(2000).optional() }).optional()

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof AiVoicesError)) throw err
    const code = ({ not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', payload_too_large: 'PAYLOAD_TOO_LARGE', quota: 'QUOTA_EXCEEDED', upstream: 'UPSTREAM_ERROR' } as const)[err.code]
    throw new ApiError(code, err.message, err.details)
  }
}

/** Corpo opcional: vazio = `{}`. */
async function optionalJson(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

export function aiVoicesRoutes(deps: ResolvedDeps) {
  let service: AiVoicesService | undefined
  const svc = () =>
    (service ??= new AiVoicesService({
      db: deps.db,
      // aiKeysDefaults (T38) roda antes das rotas: chave da empresa → plataforma.
      keys: deps.aiKeys!,
      guard: new UsageGuard({ db: deps.db, redis: deps.redis as never }),
      ...(deps.aiVoicesProvider ? { provider: deps.aiVoicesProvider } : {}),
      ...(deps.aiVoicesFetch ? { fetch: deps.aiVoicesFetch } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
    }))
  const app = new Hono<AppEnv>()
  const view = requirePerm('flows.view')
  const edit = requirePerm('flows.edit')
  const limit = bodyLimit({
    maxSize: VOICE_MAX_SAMPLES * VOICE_SAMPLE_MAX_BYTES + 2 * 1024 * 1024,
    onError: () => {
      throw new ApiError('PAYLOAD_TOO_LARGE', 'Áudios acima do limite', { error_code: 'too_large' })
    },
  })

  app.get('/api/ai-voices', view, validate('query', listQuery), async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json(await svc().list(companyId, c.req.valid('query')), 200)
  })

  app.post('/api/ai-voices', edit, limit, async (c) => {
    const ctx = getCompanyCtx(c)
    if (!/multipart\/form-data/i.test(c.req.header('content-type') ?? ''))
      throw new ApiError('VALIDATION_ERROR', 'Envie os áudios em multipart/form-data', { error_code: 'audios_count', fields: [{ path: 'audios', message: 'Envie de 1 a 3 áudios' }] })
    const body = await c.req.parseBody({ all: true })
    const files = [body['audios'], body['audios[]']].flatMap((v) => (Array.isArray(v) ? v : v === undefined ? [] : [v])).filter((v): v is File => v instanceof File)
    const audios: VoiceSampleInput[] = await Promise.all(files.map(async (f) => ({ filename: f.name || 'audio', mime: f.type || '', data: new Uint8Array(await f.arrayBuffer()) })))
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
    const voice = await domain(() => svc().create(ctx.companyId, { name: str('name'), language: str('language'), audios }, ctx.user?.id ?? null))
    setAudit(c, { action: 'ai_voices.create', targetType: 'ai_voice', targetId: voice.id, detail: { samples: voice.samples_count, language: voice.language } })
    return c.json({ voice }, 201)
  })

  app.get('/api/ai-voices/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ voice: await domain(() => svc().get(companyId, c.req.param('id'))) }, 200)
  })

  app.post('/api/ai-voices/:id/preview', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const parsed = previewBody.safeParse(await optionalJson(c))
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', 'Dados inválidos', { fields: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) })
    const res = await domain(() => svc().preview(companyId, c.req.param('id'), parsed.data?.text))
    return c.body(Buffer.from(res.audio), 200, { 'content-type': res.mime, 'cache-control': 'no-store', 'x-tts-characters': String(res.chars) })
  })

  app.post('/api/ai-voices/:id/keep', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const voice = await domain(() => svc().keep(companyId, c.req.param('id')))
    setAudit(c, { action: 'ai_voices.keep', targetType: 'ai_voice', targetId: voice.id })
    return c.json({ voice }, 200)
  })

  app.delete('/api/ai-voices/:id', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const result = await domain(() => svc().remove(companyId, id))
    setAudit(c, { action: 'ai_voices.delete', targetType: 'ai_voice', targetId: id, detail: { removed_from_agents: result.removed_from_agents.map((a) => a.id), provider_deleted: result.provider_deleted } })
    return c.json(result, 200)
  })

  return app
}
