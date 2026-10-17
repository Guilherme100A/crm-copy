// Rotas `/api/*` públicas (SPEC 3.6): login/cadastro/reset de senha, convites por token e webhooks de entrada.

export interface PublicRoute {
  method: string | '*'
  /** Caminho exato, ou prefixo quando termina em `/*`. */
  path: string
}

/** T115: rotas OAuth chamadas pelo cliente MCP (sem sessão, fora do CSRF). */
const MCP_OAUTH_CLIENT_PATHS: readonly string[] = ['/api/mcp-oauth/register', '/api/mcp-oauth/authorize', '/api/mcp-oauth/token', '/api/mcp-oauth/revoke']

export const PUBLIC_API_ROUTES: readonly PublicRoute[] = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/register' },
  { method: 'POST', path: '/api/auth/password-resets' },
  { method: 'POST', path: '/api/auth/password-resets/*' },
  // T15: validar e usar o link de redefinição (quem esqueceu a senha não tem sessão)
  { method: 'GET', path: '/api/auth/password-resets/*' },
  { method: 'PATCH', path: '/api/auth/password-resets/*' },
  { method: 'GET', path: '/api/invitations/*' },
  { method: 'POST', path: '/api/invitations/*' },
  { method: 'POST', path: '/api/hooks/*' },
  // T94: servidor MCP — autenticado pelo token Bearer da credencial MCP na própria rota (não pela sessão).
  { method: '*', path: '/api/mcp' },
  // T100: imagens globais de avisos/banners do admin (id assinado; qualquer empresa, sem sessão).
  { method: 'GET', path: '/api/public/admin-media/*' },
  // T115: URL do conector OAuth (`/api/mcp/<credencial>`) e o servidor de autorização chamado pelo cliente MCP.
  // A tela de consentimento (`/api/mcp-oauth/consent`) continua exigindo sessão.
  { method: '*', path: '/api/mcp/*' },
  ...MCP_OAUTH_CLIENT_PATHS.map((path) => ({ method: '*', path })),
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

/** Webhooks de entrada (`/api/hooks/**`) e o servidor MCP (T94, Bearer) chegam de sistemas externos: fora do CSRF guard. */
export function isInboundHook(path: string): boolean {
  return path.startsWith('/api/hooks/') || path === '/api/mcp' || path.startsWith('/api/mcp/') || MCP_OAUTH_CLIENT_PATHS.includes(path)
}
