// Empresa ativa (SPEC 3.3): `X-Company-Id` validado contra a membership; sem header, `users.last_company_id`.
// Empresa sem vínculo (ou de outra empresa, no caso de token de API) → 404 NOT_FOUND.
import type { MiddlewareHandler } from 'hono'
import { permissionsOf, resolveCompanyContext } from '@crm/core'
import type { Database } from '@crm/db'
import { ApiError } from '../lib/errors'
import type { AppEnv } from '../lib/types'

export const COMPANY_HEADER = 'x-company-id'

const notFound = () => new ApiError('NOT_FOUND', 'Empresa não encontrada')

export function companyContext(db: Database): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx')
    if (!ctx) return next() // rota pública
    const requested = c.req.header(COMPANY_HEADER)?.trim() || null

    if (ctx.auth.kind === 'api_token') {
      if (requested && requested.toLowerCase() !== ctx.companyId?.toLowerCase()) throw notFound()
      return next()
    }
    if (!ctx.user) throw new ApiError('UNAUTHORIZED', 'Não autenticado')

    const resolved = await resolveCompanyContext(db, ctx.user, requested)
    if (!resolved.ok) throw notFound()
    c.set('ctx', { ...ctx, companyId: resolved.companyId, member: resolved.member, perms: permissionsOf(resolved.member, ctx.user) })
    return next()
  }
}
