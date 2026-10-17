// Empresa desativada (T22, AC-T22-05): com ela como empresa ativa, `/api/*` responde 403 com
// `error.details.error_code = 'company_inactive'`. Ficam liberadas as rotas para sair dessa situação:
// autenticação/perfil, listar/criar/ler/editar (reativar)/desativar empresas, trocar e sair.
import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { companies } from '@crm/db'
import { ApiError } from '../../lib/errors'
import type { AppEnv, ResolvedDeps } from '../../lib/types'

const EXEMPT: Array<[method: string, path: RegExp]> = [
  ['*', /^\/api\/auth(\/.*)?$/],
  ['GET', /^\/api\/companies\/?$/],
  ['POST', /^\/api\/companies\/?$/],
  ['GET', /^\/api\/companies\/[^/]+\/?$/],
  ['PUT', /^\/api\/companies\/[^/]+\/?$/],
  ['DELETE', /^\/api\/companies\/[^/]+\/?$/],
  ['POST', /^\/api\/companies\/[^/]+\/(switch|leave)\/?$/],
]

export function isCompanyInactiveExempt(method: string, path: string): boolean {
  return EXEMPT.some(([m, re]) => (m === '*' || m === method) && re.test(path))
}

/** Admin da plataforma em `/api/admin/*` e `/api/platform/*` não depende da própria empresa ativa (T95). */
const PLATFORM_PATH = /^\/api\/(admin|platform)(\/|$)/

export function isPlatformAdminExempt(systemRole: string | undefined, path: string): boolean {
  return systemRole === 'platform_admin' && PLATFORM_PATH.test(path)
}

export function companyActiveGuard(deps: Pick<ResolvedDeps, 'db'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = c.get('ctx')
    if (!ctx?.companyId || isCompanyInactiveExempt(c.req.method, c.req.path)) return next()
    if (isPlatformAdminExempt(ctx.user?.systemRole, c.req.path)) return next()
    const [row] = await deps.db.select({ active: companies.active }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1)
    if (row && !row.active) throw new ApiError('FORBIDDEN', 'Empresa desativada', { error_code: 'company_inactive' })
    return next()
  }
}
