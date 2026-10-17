// Empresa ativa (SPEC 3.3): `X-Company-Id` validado contra a membership; sem header, `users.last_company_id`.
// Empresa sem vínculo (ou de outra empresa, no caso de token de API) → 404 NOT_FOUND.
import type { MiddlewareHandler } from 'hono'
import { permissionsOf, resolutionPermissions, resolveCompanyContext } from '@crm/core'
import type { Database } from '@crm/db'
import { ApiError } from '../lib/errors'
import type { AppEnv } from '../lib/types'
import { setAudit } from './audit'

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
    if (!resolved.ok) {
      // T32 (AC-T32-02): suporte cuja concessão nesta empresa expirou ou foi revogada → 403.
      if (resolved.reason === 'support_access_expired')
        throw new ApiError('FORBIDDEN', 'Acesso de suporte expirado ou revogado', { error_code: 'support_access_expired' })
      throw notFound()
    }
    if (resolved.supportGrant) {
      // T32: suporte por concessão ativa (sem vínculo); a auditoria identifica a concessão.
      const grant = resolved.supportGrant
      c.set('ctx', { ...ctx, companyId: resolved.companyId, member: null, perms: resolutionPermissions(resolved, ctx.user), supportGrant: grant })
      setAudit(c, { detail: { support_grant_id: grant.id } })
      return next()
    }
    c.set('ctx', { ...ctx, companyId: resolved.companyId, member: resolved.member, perms: permissionsOf(resolved.member, ctx.user) })
    return next()
  }
}
