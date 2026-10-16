// Autorização por rota (SPEC 3.3): `requirePerm('<chave>')` e `requirePlatformRole('platform_admin')`.
import type { MiddlewareHandler } from 'hono'
import type { SystemRole } from '@crm/db'
import type { PermissionKey } from '@crm/shared'
import { getCtx } from '../lib/context'
import { ApiError } from '../lib/errors'
import type { AppEnv } from '../lib/types'

/** Exige a permissão na empresa ativa. Sem sessão → 401; sem empresa ativa ou sem a chave → 403. */
export function requirePerm(key: PermissionKey | (string & {})): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = getCtx(c)
    if (!ctx.companyId || !(ctx.perms as ReadonlySet<string>).has(key))
      throw new ApiError('FORBIDDEN', 'Permissão insuficiente', { permission: key })
    return next()
  }
}

/** Exige um dos papéis de sistema (`users.system_role`). Sem sessão → 401; outro papel → 403. */
export function requirePlatformRole(...roles: [SystemRole, ...SystemRole[]]): MiddlewareHandler<AppEnv> {
  const allowed = new Set<string>(roles)
  return async (c, next) => {
    const ctx = getCtx(c)
    if (!ctx.user || !allowed.has(ctx.user.systemRole)) throw new ApiError('FORBIDDEN', 'Acesso restrito à plataforma')
    return next()
  }
}
