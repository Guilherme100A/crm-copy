// Comum às rotas Meta (T99): serviço por app (config do ambiente ou injetada), erros de domínio → SPEC 3.5 e a regra
// de gestão de perfis (11 §8: além de `facebook.profiles`, papel owner/admin na empresa ou admin da plataforma).
import { metaConfigFromEnv, MetaProfilesError, MetaProfilesService, type MetaConfig } from '@crm/core'
import type { MiddlewareHandler } from 'hono'
import { getCtx } from '../../lib/context'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'

declare module '../../lib/types' {
  interface AppDeps {
    /** Config da Meta (default: `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_URL`, `META_OAUTH_REDIRECT_URI`…). */
    metaConfig?: Partial<MetaConfig>
    /** `fetch` da Graph (testes: o FakeMetaGraph responde pela URL; isto é só para interceptar). */
    metaFetch?: typeof globalThis.fetch
    /** Chave do `state` do OAuth (default derivada de `CREDENTIALS_KEY`). */
    metaOauthStateKey?: Buffer
  }
}

const services = new WeakMap<ResolvedDeps, MetaProfilesService>()

export function metaProfilesServiceFor(deps: ResolvedDeps): MetaProfilesService {
  let svc = services.get(deps)
  if (!svc) {
    svc = new MetaProfilesService({
      db: deps.db,
      config: { ...metaConfigFromEnv(), ...deps.metaConfig },
      ...(deps.credentialsCipher ? { cipher: deps.credentialsCipher } : {}),
      ...(deps.metaFetch ? { fetch: deps.metaFetch } : {}),
      ...(deps.metaOauthStateKey ? { stateKey: deps.metaOauthStateKey } : {}),
    })
    services.set(deps, svc)
  }
  return svc
}

/** `MetaProfilesError` → SPEC 3.5. */
export async function metaDomain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof MetaProfilesError)) throw err
    if (err.code === 'not_found') throw new ApiError('NOT_FOUND', err.message)
    if (err.code === 'invalid_state') throw new ApiError('VALIDATION_ERROR', err.message, { fields: [{ path: 'state', message: err.message }] })
    if (err.code === 'not_configured') throw new ApiError('CONFLICT', err.message, { error_code: 'meta_not_configured' })
    if (err.code === 'token_invalid') throw new ApiError('CONFLICT', err.message, { error_code: 'meta_token_invalid', ...err.details })
    throw new ApiError('UPSTREAM_ERROR', err.message, { error_code: 'meta_upstream', ...err.details })
  }
}

/** Pode gerir perfis e contas: `facebook.profiles` + (owner/admin da empresa ou admin da plataforma). */
export function canManageMetaProfiles(ctx: ReturnType<typeof getCtx>): boolean {
  if (!(ctx.perms as ReadonlySet<string>).has('facebook.profiles')) return false
  if (ctx.user?.systemRole === 'platform_admin') return true
  return ctx.member?.role === 'owner' || ctx.member?.role === 'admin'
}

export const requireMetaManager: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = getCtx(c)
  if (!ctx.companyId || !canManageMetaProfiles(ctx))
    throw new ApiError('FORBIDDEN', 'Gerir perfis Meta exige facebook.profiles e papel owner/admin', { permission: 'facebook.profiles' })
  return next()
}
