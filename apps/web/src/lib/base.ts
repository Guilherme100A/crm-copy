// Prefixos da SPA quando ela roda num subcaminho (ex.: dentro do painel do ai-manager em `/crm/`).
// - `appBase()`: base da SPA (o `base` do Vite = `import.meta.env.BASE_URL`, vindo de `VITE_BASE_PATH`). Padrão `/`.
// - `apiBase()`: onde a API responde (`VITE_API_BASE`, ex.: `/crm/api`). Padrão `/api` (mesma origem, como antes).
// Sem as envs nada muda: `apiUrl('/api/x') === '/api/x'` e `appPath('/login') === '/login'`.

const trimRight = (s: string) => s.replace(/\/+$/, '')

function env(): Record<string, string | undefined> {
  try {
    return (import.meta.env ?? {}) as Record<string, string | undefined>
  } catch {
    return {}
  }
}

/** Base da SPA sem a barra final (`''` na raiz, `/crm` em `/crm/`). */
export function appBase(): string {
  return trimRight(env().BASE_URL || '/')
}

/** Base da API sem a barra final (padrão `/api`). */
export function apiBase(): string {
  return trimRight(env().VITE_API_BASE?.trim() || '/api') || '/api'
}

/** Troca o prefixo `/api` de um caminho da API pela base configurada. URLs absolutas e outros caminhos passam iguais. */
export function apiUrl(path: string, base = apiBase()): string {
  if (base === '/api') return path
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) return `${base}${path.slice(4)}`
  return path
}

/** Caminho interno da SPA (`/login`) → caminho público com a base (`/crm/login`). */
export function appPath(path: string, base = appBase()): string {
  if (!base || !path.startsWith('/')) return path
  return `${base}${path}`
}

/** Caminho público (`/crm/login`) → caminho interno da SPA (`/login`). Fora da base, devolve como está. */
export function stripAppBase(pathname: string, base = appBase()): string {
  if (!base) return pathname
  if (pathname === base) return '/'
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  return pathname
}
