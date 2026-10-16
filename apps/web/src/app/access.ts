// Regras de acesso do shell (spec 18 §2.2, §2.5, §5.2, §5.3): itens visíveis, home por papel, guarda por prefixo
// e redirecionamentos legados. Funções puras sobre a sessão (testadas em access.unit.test.ts).
import { hasAny, type Session } from '@/lib/session'
import { BOTTOM_NAV, NAV_SECTIONS, SUPPORT_NAV_SECTIONS, type NavItem, type NavSection } from './nav'

type Access = Pick<Session, 'isOwner' | 'isSupport' | 'isPlatformAdmin' | 'perms'>

/** Seções com os itens que a sessão pode ver; seção vazia some (spec 18 §2.5). */
export function visibleSections(session: Access): NavSection[] {
  const base = session.isSupport ? SUPPORT_NAV_SECTIONS : NAV_SECTIONS
  const sections = base
    .map((s) => ({ ...s, items: s.items.filter((i) => itemVisible(session, i)) }))
    .filter((s) => s.items.some((i) => i.to && i.id !== 'admin'))
  return sections
}

function itemVisible(session: Access, item: NavItem): boolean {
  if (item.platformAdminOnly) return session.isPlatformAdmin
  return hasAny(session, item.permissions)
}

export function visibleBottomNav(session: Access) {
  if (session.isSupport) return BOTTOM_NAV.filter((i) => i.id === 'home' || i.id === 'flows').map((i) => (i.id === 'home' ? { ...i, permissions: [] } : i))
  return BOTTOM_NAV.filter((i) => hasAny(session, i.permissions))
}

/**
 * Tabela de prefixos (spec 18 §5.3): vence o PRIMEIRO prefixo que casar (exato ou `prefixo/…`). `null` = livre;
 * caminho fora da tabela não tem checagem. Cobranças fora de escopo; o resto como na referência.
 */
export const ROUTE_PERMISSIONS: ReadonlyArray<readonly [prefix: string, perms: readonly string[] | null]> = [
  ['/profile', null],
  ['/support/access', null],
  ['/settings/support-access', null],
  ['/global_variables', null],
  ['/settings/mcp-credentials', ['settings.mcp.view']],
  ['/integrations/ai', ['settings.mcp.view']],
  ['/welcome', ['dashboard.sales', 'dashboard.support']],
  ['/chats', ['chat.view']],
  ['/chat', ['chat.view']],
  ['/crms', ['kanban.view']],
  ['/flows', ['flows.view']],
  ['/agentes', ['flows.view']],
  ['/customers', ['contacts.view']],
  ['/mass-dispatches', ['contacts.view']],
  ['/settings/inbound-webhooks', ['webhooks.view']],
  ['/connections', ['connections.view']],
  ['/users', ['team.view']],
  ['/labels', ['settings.labels.view']],
  ['/departments', ['settings.departments.view']],
  ['/customer_custom_fields', ['settings.fields.view']],
  ['/products', ['settings.products.view']],
  ['/integrations', ['settings.integrations.view']],
  ['/connection_flow_configs', ['settings.dispatch.view']],
  ['/business-hours', ['settings.business_hours.view']],
  ['/quick_replies', ['settings.quick_replies.view']],
  ['/accounts', ['settings.accounts.view']],
  ['/settings/invitations', ['settings.platform_invitations.view']],
  ['/settings', ['settings.view', 'settings.mcp.view']],
  ['/facebook', ['facebook.campaigns', 'facebook.pixel', 'facebook.profiles']],
]

const matches = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/** Caminhos permitidos ao usuário `support` (spec 18 §5.3 item 1). */
function supportAllowed(path: string): boolean {
  return path === '/settings' || ['/support/access', '/settings/mcp-credentials', '/profile', '/flows'].some((p) => matches(path, p))
}

/** A sessão pode abrir o caminho? (só o pathname, sem query) */
export function canAccess(session: Access, pathname: string): boolean {
  if (pathname === '/' || pathname === '/login') return true
  if (matches(pathname, '/admin')) return session.isPlatformAdmin
  if (session.isSupport) return supportAllowed(pathname)
  if (matches(pathname, '/support/access')) return false
  const rule = ROUTE_PERMISSIONS.find(([prefix]) => matches(pathname, prefix))
  if (!rule || rule[1] === null) return true
  return hasAny(session, rule[1])
}

/**
 * Home do papel (spec 18 §5.2): support → `/support/access`; com dashboard → `/welcome`; senão a primeira rota
 * permitida da navegação (evita loop em `/welcome` para quem não tem dashboard), e por fim `/profile`.
 */
export function homeOf(session: Access): string {
  if (session.isSupport) return '/support/access'
  if (canAccess(session, '/welcome')) return '/welcome'
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.to && itemVisible(session, item) && canAccess(session, item.to.split('?')[0]!)) return item.to
    }
  }
  return '/profile'
}

/** Redirecionamentos legados (spec 18 §2.2), todos `replace`. */
export const LEGACY_REDIRECTS: Readonly<Record<string, { to: string; search?: Record<string, string> }>> = {
  '/chat': { to: '/chats' },
  '/quick_replies': { to: '/settings', search: { tab: 'quick_replies' } },
  '/global_variables': { to: '/settings', search: { tab: 'global_variables' } },
  '/integrations': { to: '/settings', search: { tab: 'integrations' } },
  '/integrations/nf-issuer': { to: '/settings', search: { tab: 'integrations' } },
  '/integrations/utmify': { to: '/settings', search: { tab: 'integrations' } },
  '/integrations/payments': { to: '/settings', search: { tab: 'integrations' } },
  '/integrations/ai': { to: '/settings', search: { tab: 'integrations' } },
  '/invoice_integrations': { to: '/settings', search: { tab: 'integrations' } },
  '/customer_custom_fields': { to: '/settings', search: { tab: 'custom_fields' } },
  '/connection_flow_configs': { to: '/settings', search: { tab: 'connection_flow_configs' } },
  '/business-hours': { to: '/settings', search: { tab: 'accounts', company_tab: 'hours' } },
  '/labels': { to: '/settings', search: { tab: 'tags' } },
  '/departments': { to: '/settings', search: { tab: 'accounts', company_tab: 'departments' } },
  '/users': { to: '/settings', search: { tab: 'team' } },
  '/settings/labels': { to: '/settings', search: { tab: 'tags' } },
  '/settings/pixels': { to: '/facebook/pixel' },
  '/settings/meta': { to: '/facebook/profiles' },
  '/settings/mcp-credentials': { to: '/settings', search: { tab: 'mcp_credentials' } },
  '/settings/support-access': { to: '/settings', search: { tab: 'support_access' } },
}
