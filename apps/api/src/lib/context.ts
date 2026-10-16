// Acesso tipado ao contexto da requisição autenticada (`{ user, companyId, member, perms }`).
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { RequestContext } from '@crm/core'
import { ApiError } from './errors'
import type { AppEnv } from './types'

/** Contexto autenticado; lança 401 se a rota não passou pelo `sessionAuth`. */
export function getCtx(c: Context<AppEnv>): RequestContext {
  const ctx = c.get('ctx')
  if (!ctx) throw new ApiError('UNAUTHORIZED', 'Não autenticado')
  return ctx
}

export type CompanyRequestContext = RequestContext & { companyId: string }

/** Contexto com empresa ativa obrigatória; sem empresa → 403. */
export function getCompanyCtx(c: Context<AppEnv>): CompanyRequestContext {
  const ctx = getCtx(c)
  if (!ctx.companyId) throw new ApiError('FORBIDDEN', 'Nenhuma empresa ativa')
  return ctx as CompanyRequestContext
}

/** IP do cliente: `X-Forwarded-For` só com `trustProxy`; senão o socket (indisponível em `app.request()`). */
export function clientIp(c: Context, trustProxy = false): string | null {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  try {
    return getConnInfo(c).remote.address ?? null
  } catch {
    return null
  }
}
