// Guarda de navegação do shell (spec 18 §2.2, §5.2, §5.3; AC-T23-01/02/05), como função pura sobre a sessão:
// sem sessão → `/login?redirect=`; `/` → home do papel; sem permissão → home do papel (1ª rota permitida) com aviso.
import { loginPath } from '@/lib/redirect'
import type { Session } from '@/lib/session'
import { canAccess, homeOf, LEGACY_REDIRECTS } from './access'

/** Rotas públicas (sem shell e sem sessão obrigatória). T36: telas de autenticação (spec 01 §2). */
export const PUBLIC_PATHS = ['/login', '/register', '/cadastro', '/forgot-password', '/reset-password'] as const

/** T36: rotas abertas por prefixo (com ou sem sessão, sem shell): o convite (`/invitations/<token>`). */
export const OPEN_PATH_PREFIXES = ['/invitations/', '/invitation/'] as const

export const isPublicPath = (pathname: string) =>
  (PUBLIC_PATHS as readonly string[]).includes(pathname) || OPEN_PATH_PREFIXES.some((p) => pathname.startsWith(p))

export type GuardDecision =
  | { kind: 'allow' }
  | { kind: 'redirect'; href: string; denied: boolean }

/** `href` = caminho + query (`location.pathname + location.searchStr`). */
export function decide(session: Session | null, pathname: string, href: string): GuardDecision {
  const legacy = LEGACY_REDIRECTS[pathname]
  if (legacy) {
    const qs = legacy.search ? `?${new URLSearchParams(legacy.search).toString()}` : ''
    return { kind: 'redirect', href: `${legacy.to}${qs}`, denied: false }
  }
  if (isPublicPath(pathname)) return { kind: 'allow' }
  if (!session) return { kind: 'redirect', href: loginPath(href), denied: false }
  if (pathname === '/') return { kind: 'redirect', href: homeOf(session), denied: false }
  if (!canAccess(session, pathname)) return { kind: 'redirect', href: homeOf(session), denied: true }
  return { kind: 'allow' }
}

/**
 * O aviso de permissão negada aparece no máximo uma vez por caminho seguido (spec 18 §5.3 item 4): a mesma
 * tentativa reavaliada pelo router (redirect, revalidação) dentro da janela não repete o toast.
 */
export class DeniedNotice {
  private last: string | null = null
  private at = 0

  constructor(private readonly windowMs = 3000) {}

  /** `true` se é para mostrar o aviso agora. */
  shouldNotify(pathname: string, now = Date.now()): boolean {
    if (this.last === pathname && now - this.at < this.windowMs) return false
    this.last = pathname
    this.at = now
    return true
  }
}

/**
 * Aviso de permissão negada decidido antes de o React montar (carga inicial): o shell o mostra ao montar.
 * Assim a URL negada é trocada antes do router existir e não gera navegação extra.
 */
let pendingDenied = false

export function deferDeniedNotice(): void {
  pendingDenied = true
}

export function takeDeniedNotice(): boolean {
  const v = pendingDenied
  pendingDenied = false
  return v
}

/** `/settings?tab=x` → `{ to: '/settings', search: { tab: 'x' } }` para o `redirect()` do router. */
export function splitHref(href: string): { to: string; search: Record<string, string> } {
  const url = new URL(href, 'http://local')
  return { to: url.pathname, search: Object.fromEntries(url.searchParams) }
}
