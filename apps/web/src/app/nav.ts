// Registro da navegação do shell (SPEC 2.4, compartilhado ADITIVO): seções e itens da sidebar/drawer e da barra
// inferior mobile, na ordem da spec 18 §2.5/§2.6. Cada tarefa de módulo ajusta/acrescenta o seu item aqui.
// `permissions`: qualquer uma basta; owner sempre vê; sem permissões = sempre visível.
import type { LucideIcon } from 'lucide-react'
import {
  Bot,
  Cable,
  ExternalLink,
  Megaphone,
  Kanban,
  LayoutDashboard,
  MessagesSquare,
  Send,
  Settings,
  ShieldCheck,
  Users,
  Webhook,
  Workflow,
  Home,
  KeyRound,
} from 'lucide-react'

export interface NavItem {
  /** `data-testid="nav-item-<id>"`. */
  id: string
  /** Chave i18n (namespace `shell`). */
  labelKey: string
  icon: LucideIcon
  /** Rota interna; ou `href` externo (abre em nova aba). */
  to?: string
  href?: string
  permissions?: readonly string[]
  /** Só para `system_role === 'platform_admin'`. */
  platformAdminOnly?: boolean
  badgeKey?: string
}

export interface NavSection {
  id: 'main' | 'operations' | 'management'
  labelKey: string
  items: NavItem[]
}

/** URL externa dos tutoriais (configurável; T108). */
export const TUTORIALS_URL: string = (import.meta.env.VITE_TUTORIALS_URL as string | undefined) || 'https://www.youtube.com/'

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'main',
    labelKey: 'nav.sections.main',
    items: [
      { id: 'dashboard', labelKey: 'nav.items.dashboard', icon: LayoutDashboard, to: '/welcome', permissions: ['dashboard.sales', 'dashboard.support'] },
      { id: 'chats', labelKey: 'nav.items.chats', icon: MessagesSquare, to: '/chats', permissions: ['chat.view'] },
      { id: 'kanban', labelKey: 'nav.items.kanban', icon: Kanban, to: '/crms', permissions: ['kanban.view'] },
      { id: 'contacts', labelKey: 'nav.items.contacts', icon: Users, to: '/customers', permissions: ['contacts.view'] },
    ],
  },
  {
    id: 'operations',
    labelKey: 'nav.sections.operations',
    items: [
      { id: 'flows', labelKey: 'nav.items.flows', icon: Workflow, to: '/flows', permissions: ['flows.view'] },
      { id: 'agents', labelKey: 'nav.items.agents', icon: Bot, to: '/agentes', permissions: ['flows.view'], badgeKey: 'nav.badges.new' },
      { id: 'connections', labelKey: 'nav.items.connections', icon: Cable, to: '/connections', permissions: ['connections.view'] },
      { id: 'inbound-webhooks', labelKey: 'nav.items.inboundWebhooks', icon: Webhook, to: '/settings/inbound-webhooks', permissions: ['webhooks.view'] },
      { id: 'mass-dispatch', labelKey: 'nav.items.massDispatch', icon: Send, to: '/mass-dispatches', permissions: ['contacts.view'] },
      { id: 'facebook', labelKey: 'nav.items.facebook', icon: Megaphone, to: '/facebook', permissions: ['facebook.campaigns', 'facebook.pixel', 'facebook.profiles'] },
    ],
  },
  {
    id: 'management',
    labelKey: 'nav.sections.management',
    items: [
      // Cobranças fora de escopo (SPEC 8): sem item de billing.
      { id: 'settings', labelKey: 'nav.items.settings', icon: Settings, to: '/settings', permissions: ['settings.view'] },
      { id: 'admin', labelKey: 'nav.items.admin', icon: ShieldCheck, to: '/admin', platformAdminOnly: true },
      { id: 'tutorials', labelKey: 'nav.items.tutorials', icon: ExternalLink, href: TUTORIALS_URL },
    ],
  },
]

/** Menu reduzido do usuário de suporte (spec 18 §2.5). */
export const SUPPORT_NAV_SECTIONS: NavSection[] = [
  {
    id: 'main',
    labelKey: 'nav.sections.main',
    items: [
      { id: 'support-access', labelKey: 'nav.items.supportAccess', icon: ShieldCheck, to: '/support/access' },
      { id: 'mcp-credentials', labelKey: 'nav.items.mcpCredentials', icon: KeyRound, to: '/settings?tab=mcp_credentials', permissions: ['settings.mcp.view'] },
    ],
  },
]

export interface BottomNavItem {
  /** `data-testid="bottom-nav-<id>"`. */
  id: 'home' | 'chats' | 'kanban' | 'flows'
  labelKey: string
  icon: LucideIcon
  /** `home` vai para a home do papel. */
  to: string | 'home'
  permissions?: readonly string[]
}

/** Barra inferior mobile (spec 18 §2.6); "Mais" (abre o drawer) é fixo no shell. */
export const BOTTOM_NAV: BottomNavItem[] = [
  { id: 'home', labelKey: 'bottomNav.home', icon: Home, to: 'home', permissions: ['dashboard.sales', 'dashboard.support'] },
  { id: 'chats', labelKey: 'nav.items.chats', icon: MessagesSquare, to: '/chats', permissions: ['chat.view'] },
  { id: 'kanban', labelKey: 'nav.items.kanban', icon: Kanban, to: '/crms', permissions: ['kanban.view'] },
  { id: 'flows', labelKey: 'nav.items.flows', icon: Workflow, to: '/flows', permissions: ['flows.view'] },
]
