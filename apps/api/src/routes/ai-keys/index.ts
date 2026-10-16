// Chaves de provedores de IA (SPEC T38; 07-agentes-ia.md §3.8, 19-integracoes.md §3.3/§6). Leitura com
// settings.integrations.view; criar/editar/testar com .edit; excluir com .delete. O segredo nunca volta na resposta.
import { Hono, type Context } from 'hono'
import { AiKeysError, AiKeysService, type AiKeyProbe } from '@crm/core'
import { getCompanyCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { setAudit } from '../../middleware/audit'
import { requirePerm } from '../../middleware/authorize'

declare module '../../lib/types' {
  interface AppDeps {
    /** Serviço das chaves BYOK. Default: `new AiKeysService({ db, cipher: credentialsCipher, probe: aiKeyProbe, fetch: aiKeysFetch })`. */
    aiKeys?: AiKeysService
    /** Teste da chave no provedor (fake nos testes). Default: chamada HTTP barata ao provedor. */
    aiKeyProbe?: AiKeyProbe
    /** `fetch` das listagens de modelos (OpenRouter) e vozes (ElevenLabs). Default: global. */
    aiKeysFetch?: typeof globalThis.fetch
  }
}

/**
 * Antes das rotas que leem `deps.aiProviderKeys` (agentes, T39): a verificação de provedor configurado passa a ser
 * BYOK (chave da empresa, senão a da plataforma). Mantém o que já tiver sido injetado.
 */
export function aiKeysDefaults(deps: ResolvedDeps): void {
  deps.aiKeys ??= new AiKeysService({
    db: deps.db,
    // Mesmo cifrador injetável das conexões (T40); default `CREDENTIALS_KEY`.
    ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
    ...(deps.aiKeyProbe ? { probe: deps.aiKeyProbe } : {}),
    ...(deps.aiKeysFetch ? { fetch: deps.aiKeysFetch } : {}),
  })
  deps.aiProviderKeys ??= deps.aiKeys
}

function toApiError(err: unknown): unknown {
  if (!(err instanceof AiKeysError)) return err
  const map = { not_found: 'NOT_FOUND', validation: 'VALIDATION_ERROR', conflict: 'CONFLICT', upstream: 'UPSTREAM_ERROR' } as const
  return new ApiError(map[err.code], err.message, err.details)
}

async function domain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toApiError(err)
  }
}

/** JSON do corpo; vazio vira `{}`. Nunca ecoa o corpo em erro. */
async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiError('MALFORMED_REQUEST', 'JSON inválido')
  }
}

/** Aceita o envelope do produto de referência `{ ai_integration: {...} }`. */
const unwrap = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'ai_integration' in v && Object.keys(v).length === 1 ? (v as { ai_integration: unknown }).ai_integration : v

export function aiKeysRoutes(deps: ResolvedDeps) {
  aiKeysDefaults(deps)
  const service = deps.aiKeys!
  const app = new Hono<AppEnv>()
  const view = requirePerm('settings.integrations.view')
  const edit = requirePerm('settings.integrations.edit')
  const del = requirePerm('settings.integrations.delete')
  const actor = (c: Context<AppEnv>) => getCompanyCtx(c).user?.id ?? null

  app.get('/api/ai-keys', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.list(companyId)) }, 200)
  })

  app.post('/api/ai-keys', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const key = await domain(async () => service.create(companyId, unwrap(await jsonBody(c)), actor(c)))
    setAudit(c, { action: 'ai_keys.create', targetType: 'ai_key', targetId: key.id, detail: { provider: key.provider, name: key.name } })
    return c.json({ key }, 201)
  })

  app.get('/api/ai-keys/:id', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ key: await domain(() => service.get(companyId, c.req.param('id'))) }, 200)
  })

  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/ai-keys/:id', edit, async (c) => {
      const { companyId } = getCompanyCtx(c)
      const body = unwrap(await jsonBody(c))
      const key = await domain(() => service.update(companyId, c.req.param('id'), body))
      const fields = body && typeof body === 'object' ? Object.keys(body).filter((k) => k !== 'secret' && k !== 'integration_token') : []
      const secretChanged = !!body && typeof body === 'object' && ['secret', 'integration_token'].some((k) => String((body as Record<string, unknown>)[k] ?? '').trim())
      setAudit(c, { action: 'ai_keys.update', targetType: 'ai_key', targetId: key.id, detail: { fields, secret_changed: secretChanged } })
      return c.json({ key }, 200)
    })
  }

  app.delete('/api/ai-keys/:id', del, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const id = c.req.param('id')
    const force = ['1', 'true'].includes(c.req.query('force') ?? '')
    const { deleted, usage } = await domain(() => service.remove(companyId, id, { force }))
    setAudit(c, {
      action: 'ai_keys.delete',
      targetType: 'ai_key',
      targetId: id,
      detail: { provider: deleted.provider, name: deleted.name, force, agents: usage.agents.length, flows: usage.flows.length },
    })
    return c.json({ ok: true }, 200)
  })

  app.post('/api/ai-keys/:id/test', edit, async (c) => {
    const { companyId } = getCompanyCtx(c)
    const result = await domain(() => service.test(companyId, c.req.param('id')))
    setAudit(c, { action: 'ai_keys.test', targetType: 'ai_key', targetId: c.req.param('id'), detail: { ok: result.ok } })
    return c.json(result, 200)
  })

  app.get('/api/ai-keys/:id/models', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.models(companyId, c.req.param('id'))) }, 200)
  })

  app.get('/api/ai-keys/:id/voices', view, async (c) => {
    const { companyId } = getCompanyCtx(c)
    return c.json({ items: await domain(() => service.voices(companyId, c.req.param('id'))) }, 200)
  })

  return app
}
