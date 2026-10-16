// Proteção CSRF simples (SPEC 3.4), além do SameSite=Lax: requisição mutante do navegador (sem `Authorization`)
// exige `X-Requested-With: crm`. Tokens de API (Bearer) e webhooks de entrada (`/api/hooks/**`) ficam de fora.
import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../lib/errors'
import type { AppEnv } from '../lib/types'
import { isInboundHook } from './public-routes'

export const CSRF_HEADER = 'x-requested-with'
export const CSRF_HEADER_VALUE = 'crm'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || isInboundHook(c.req.path)) return next()
    if (c.get('ctx')?.auth.kind === 'api_token') return next()
    if (c.req.header(CSRF_HEADER)?.trim().toLowerCase() !== CSRF_HEADER_VALUE)
      throw new ApiError('FORBIDDEN', 'Cabeçalho X-Requested-With ausente')
    return next()
  }
}
