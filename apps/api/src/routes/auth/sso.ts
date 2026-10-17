// SSO do painel do ai-manager: `POST /api/auth/sso { token }` (contrato combinado com o ai-manager).
// - Só existe com `CRM_SSO_SECRET` definido; sem ele responde 404 (como uma rota inexistente).
// - JWT HS256: assinatura, iss 'ai-manager', aud 'crm', iat/exp com tolerância de relógio (`verifySsoToken`).
// - `jti` de uso único: Redis `SET NX` com TTL até o fim da validade (+ tolerância). Reapresentado → 401.
// - Usuário achado ou criado pelo e-mail, empresa padrão "ai-manager" e sessão criada como no login normal
//   (mesmo cookie `crm_session`, mesmos guards). Auditoria `auth.sso`.
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { SSO_CLOCK_SKEW_SEC, SsoTokenError, verifySsoToken, type AuthService } from '@crm/core'
import { setAudit } from '../../middleware/audit'
import { clientIp } from '../../lib/context'
import { setSessionCookie } from '../../lib/cookies'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'
import { validate } from '../../lib/validate'

declare module '../../lib/types' {
  interface AppDeps {
    /** Segredo HS256 do SSO do ai-manager (default `process.env.CRM_SSO_SECRET`, lido a cada requisição). Vazio = rota desligada. */
    ssoSecret?: string
    /** Relógio do SSO em segundos (testes). */
    ssoNowSec?: () => number
  }
}

export const SSO_PATH = '/api/auth/sso'
export const SSO_JTI_PREFIX = 'crm:sso:jti:'

const ssoSchema = z.object({ token: z.string().min(1).max(4096) })

export function ssoRoutes(deps: ResolvedDeps, service: AuthService, opts: { cookieSecure: boolean }) {
  const app = new Hono<AppEnv>()
  const secret = () => (deps.ssoSecret ?? process.env.CRM_SSO_SECRET ?? '').trim()
  const nowSec = () => (deps.ssoNowSec ? deps.ssoNowSec() : Math.floor(Date.now() / 1000))
  const ip = (c: Context<AppEnv>) => clientIp(c, deps.trustProxy)

  // Sem segredo a rota "não existe" (antes da validação do corpo, para não revelar o formato).
  const enabled: MiddlewareHandler<AppEnv> = async (_c, next) => {
    if (!secret()) throw new ApiError('NOT_FOUND', 'Rota não encontrada')
    await next()
  }

  app.post(SSO_PATH, enabled, validate('json', ssoSchema), async (c) => {
    const { token } = c.req.valid('json')
    const now = nowSec()
    let claims
    try {
      claims = verifySsoToken(token, secret(), { nowSec: now })
    } catch (err) {
      if (!(err instanceof SsoTokenError)) throw err
      c.get('logger')?.warn({ reason: err.code, ip: ip(c) }, 'sso token rejected')
      throw new ApiError('UNAUTHORIZED', 'Token de acesso inválido ou expirado', { error_code: `sso_${err.code}` })
    }

    // Uso único: só o primeiro SET NX vence; a chave vive até o token não valer mais.
    const ttl = Math.max(1, claims.exp + SSO_CLOCK_SKEW_SEC - now)
    const first = await deps.redis.set(`${SSO_JTI_PREFIX}${claims.jti}`, '1', 'EX', ttl, 'NX')
    if (first !== 'OK') {
      c.get('logger')?.warn({ reason: 'replayed', ip: ip(c) }, 'sso token rejected')
      throw new ApiError('UNAUTHORIZED', 'Token de acesso já usado', { error_code: 'sso_replayed' })
    }

    const result = await service.ssoLogin({ email: claims.email, name: claims.name }, { userAgent: c.req.header('user-agent') ?? null, ip: ip(c) })
    setSessionCookie(c, result.token, result.expiresAt, { secure: opts.cookieSecure })
    // Auditoria explícita (o middleware genérico não tem o usuário: a requisição chegou sem sessão).
    setAudit(c, { skip: true })
    await deps.audit
      .record({
        companyId: result.companyId,
        actorUserId: result.user.id,
        action: 'auth.sso',
        targetType: 'user',
        targetId: result.user.id,
        detail: { issuer: claims.iss, sub: claims.sub, jti: claims.jti, user_created: result.userCreated, role: result.role },
        ip: ip(c),
      })
      .catch((err: unknown) => c.get('logger')?.error({ err }, 'failed to write audit log'))
    return c.json({ user: result.user, companies: result.companies }, 200)
  })

  return app
}
