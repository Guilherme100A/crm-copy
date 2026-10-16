// Rotas `/api/*` públicas (SPEC 3.6): login/cadastro/reset de senha, convites por token e webhooks de entrada.

export interface PublicRoute {
  method: string | '*'
  /** Caminho exato, ou prefixo quando termina em `/*`. */
  path: string
}

export const PUBLIC_API_ROUTES: readonly PublicRoute[] = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/password-resets' },
  { method: 'POST', path: '/api/auth/password-resets/*' },
  { method: 'GET', path: '/api/invitations/*' },
  { method: 'POST', path: '/api/invitations/*' },
  { method: 'POST', path: '/api/hooks/*' },
]

function matches(route: PublicRoute, method: string, path: string): boolean {
  if (route.method !== '*' && route.method !== method) return false
  if (route.path.endsWith('/*')) {
    const base = route.path.slice(0, -2)
    return path.startsWith(`${base}/`) && path.length > base.length + 1
  }
  return path === route.path
}

export function isPublicApiRoute(method: string, path: string, extra: readonly PublicRoute[] = []): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  return [...PUBLIC_API_ROUTES, ...extra].some((r) => matches(r, method, p))
}

/** Webhooks de entrada (`/api/hooks/**`) chegam de sistemas externos: fora do CSRF guard. */
export function isInboundHook(path: string): boolean {
  return path.startsWith('/api/hooks/')
}
