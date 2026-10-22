// Autenticação de `/api/*` (SPEC 3.4): cookie `crm_session` (navegador) ou `Authorization: Bearer crm_pat_…`
// (integrações). Sem credencial, ou credencial inválida/expirada/revogada → 401 UNAUTHORIZED. Chamada interna de
// ferramenta MCP (`MCP_ACTOR` no env do fetch) já chega com usuário, empresa e permissões resolvidos.
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE, apiTokenPermissions, type SessionService } from '@crm/core'
import { clearSessionCookie, setSessionCookie } from '../lib/cookies'
import { ApiError } from '../lib/errors'
import { mcpActorOf } from '../lib/mcp-actor'
import type { AppEnv } from '../lib/types'
import { isPublicApiRoute, type PublicRoute } from './public-routes'

export interface SessionAuthOptions {
  sessions: SessionService
  cookieSecure: boolean
  publicRoutes?: readonly PublicRoute[]
}

/** Extrai o token de `Authorization: Bearer <token>`; `undefined` se ausente ou malformado. */
export function parseBearer(header: string | undefined): string | undefined {
  return header?.match(/^Bearer\s+(\S+)\s*$/i)?.[1]
}

export function sessionAuth(opts: SessionAuthOptions): MiddlewareHandler<AppEnv> {
  const { sessions, cookieSecure } = opts
  return async (c, next) => {
    const actor = mcpActorOf(c.env)
    if (actor) {
      c.set('ctx', {
        user: actor.user,
        companyId: actor.companyId,
        member: actor.member,
        perms: actor.perms,
        auth: { kind: 'mcp', mcpCredentialId: actor.credentialId },
      })
      return next()
    }
    if (isPublicApiRoute(c.req.method, c.req.path, opts.publicRoutes)) return next()

    const authorization = c.req.header('authorization')
    if (authorization !== undefined) {
      const verified = await sessions.verifyApiToken(parseBearer(authorization))
      if (!verified) throw new ApiError('UNAUTHORIZED', 'Token de API inválido, expirado ou revogado')
      c.set('ctx', {
        user: verified.user,
        companyId: verified.companyId,
        member: null,
        perms: apiTokenPermissions(),
        auth: { kind: 'api_token', tokenId: verified.tokenId },
      })
      return next()
    }

    const token = getCookie(c, SESSION_COOKIE)
    if (!token) throw new ApiError('UNAUTHORIZED', 'Não autenticado')
    const verified = await sessions.verify(token)
    if (!verified) {
      clearSessionCookie(c, { secure: cookieSecure })
      throw new ApiError('UNAUTHORIZED', 'Sessão inválida ou expirada')
    }
    if (verified.renewed) setSessionCookie(c, token, verified.expiresAt, { secure: cookieSecure })
    // Empresa e permissões são resolvidas no `companyContext`.
    c.set('ctx', {
      user: verified.user,
      companyId: null,
      member: null,
      perms: new Set(),
      auth: { kind: 'session', sessionId: verified.sessionId },
    })
    return next()
  }
}
