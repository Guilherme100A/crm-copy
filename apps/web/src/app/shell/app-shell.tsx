// Shell autenticado (spec 18 §2.4–§2.8): sidebar desktop 240/64 px colapsável e persistida, drawer mobile, header
// mobile, barra inferior mobile, breadcrumbs, título da aba com APP_NAME e realtime da empresa ativa.
import { Link, useRouterState } from '@tanstack/react-router'
import { Menu as MenuIcon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
// T100: pop-up do aviso ativo da plataforma (fechar só oculta localmente).
import { AnnouncementPopup } from '@/features/admin/announcement-popup'
import { CompanySwitcher } from '@/features/company-switcher/company-switcher'
// T84: sino/central de notificações; import ESTÁTICO (registra message.created/notification.created antes do SSE abrir).
import { NotificationBell } from '@/features/notifications/bell'
// T59: chip de saldo de IA; o import eager registra o handler `ai_wallet.updated` antes de o SSE abrir.
import { WalletChip } from '@/features/settings-ai-usage/wallet-chip'
// T54: import ESTÁTICO (registra os handlers support_access.* antes do SSE abrir).
import { SupportApprovalModal } from '@/features/settings-support/approval-modal'
// T97: item "Programa de afiliados" (só com AFFILIATE_PORTAL_URL, via GET /api/app-config).
import { AffiliateEntry } from '@/features/affiliate/affiliate-entry'
// T107: import ESTÁTICO (registra os handlers connection.* do indicador de queda antes do SSE abrir).
import '@/features/shell-disconnect/realtime'
// T102: import ESTÁTICO (registra `company.updated` antes do SSE abrir; o hub de Configurações é lazy).
import '@/features/settings-company/realtime'
// T108: botão "Suporte" e widget de suporte plugável (import estático; config via GET /api/app-config).
import { SupportButton, SupportWidget } from '@/features/support-widget/support-widget'
import { useT } from '@/i18n'
import { isEmbedded } from '@/lib/embed'
import { useRealtime } from '@/lib/realtime'
import type { Session } from '@/lib/session'
import { readStorage, STORAGE_KEYS, writeStorage } from '@/lib/storage'
import { useIsDesktop } from '@/lib/use-media-query'
import { APP_NAME, cn } from '@/lib/utils'
import { homeOf, visibleBottomNav } from '../access'
import { Breadcrumbs, usePageTitle } from './breadcrumbs'
import { LanguageSelect, ThemeToggle, UserMenu } from './controls'
import { NavList } from './nav-list'

/**
 * Nome do produto. Embutido no painel do ai-manager (que já mostra a marca e o menu global), fica só para leitores de
 * tela: a navegação do CRM continua inteira.
 */
function AppName({ collapsed = false }: { collapsed?: boolean }) {
  if (isEmbedded()) {
    return (
      <span data-testid="shell-app-name" className="sr-only">
        {APP_NAME}
      </span>
    )
  }
  return (
    <span data-testid="shell-app-name" className={cn('truncate text-base font-semibold', collapsed && 'sr-only')}>
      {APP_NAME}
    </span>
  )
}

/** Rodapé comum (sidebar e drawer): tema, idioma e cartão do usuário. Embutido: tema e idioma vêm do painel. */
function ShellFooter({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const embedded = isEmbedded()
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <SupportButton session={session} collapsed={collapsed} />
      <AffiliateEntry collapsed={collapsed} />
      {embedded ? null : <ThemeToggle collapsed={collapsed} />}
      {collapsed || embedded ? null : <LanguageSelect session={session} className="px-1" />}
      <UserMenu session={session} compact={collapsed} />
    </div>
  )
}

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const t = useT()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [collapsed, setCollapsed] = useState(() => readStorage(STORAGE_KEYS.sidebarCollapsed) === 'true')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const home = homeOf(session)

  useRealtime(session.company?.id)
  usePageTitle()

  // O drawer fecha ao trocar de rota e com Escape (spec 18 §2.6).
  useEffect(() => setDrawerOpen(false), [pathname])
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeStorage(STORAGE_KEYS.sidebarCollapsed, String(!c))
      return !c
    })
  }

  const bottomItems = visibleBottomNav(session)
  // Só um conjunto de navegação existe no DOM por vez (sidebar OU header/drawer/barra inferior).
  const isDesktop = useIsDesktop()

  return (
    <div className="flex min-h-dvh w-full" data-embedded={isEmbedded() ? 'true' : undefined}>
      {/* Sidebar desktop (a partir de lg). */}
      {isDesktop ? (
        <aside
          data-testid="shell-sidebar"
          data-collapsed={collapsed ? 'true' : 'false'}
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 flex-col gap-4 overflow-hidden border-r bg-sidebar p-3 text-sidebar-foreground transition-[width] lg:flex',
            collapsed ? 'w-16' : 'w-60',
          )}
        >
          <div className={cn('flex items-center gap-2', collapsed ? 'flex-col' : 'justify-between px-1')}>
            <Link to={home as never} className="min-w-0">
              <AppName collapsed={collapsed} />
            </Link>
            <button
              type="button"
              data-testid="shell-sidebar-toggle"
              onClick={toggleCollapsed}
              aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              aria-expanded={!collapsed}
              className="rounded-md p-1.5 hover:bg-accent"
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </div>
          <CompanySwitcher session={session} collapsed={collapsed} />
          <WalletChip session={session} collapsed={collapsed} />
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <NavList session={session} collapsed={collapsed} />
          </div>
          <NotificationBell session={session} collapsed={collapsed} />
          <ShellFooter session={session} collapsed={collapsed} />
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header mobile. */}
        {isDesktop ? null : (
          <header
            data-testid="shell-mobile-header"
            className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur lg:hidden"
          >
            <button
              type="button"
              data-testid="shell-drawer-open"
              onClick={() => setDrawerOpen(true)}
              aria-label={t('sidebar.openMenu')}
              aria-expanded={drawerOpen}
              className="rounded-md p-2 hover:bg-accent"
            >
              <MenuIcon className="size-5" />
            </button>
            <Link to={home as never} className="min-w-0 flex-1">
              <AppName />
            </Link>
            <NotificationBell session={session} />
            <UserMenu session={session} compact />
          </header>
        )}

        <main id="main" className="min-w-0 flex-1 px-4 pt-4 pb-24 lg:px-6 lg:pb-6">
          <Breadcrumbs />
          {children}
        </main>
      </div>

      {/* Drawer mobile: mesmo conteúdo da sidebar (spec 18 §2.4, §2.6). */}
      {!isDesktop && drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            data-testid="shell-drawer-backdrop"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside
            data-testid="shell-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t('nav.label')}
            className="absolute inset-y-0 left-0 flex w-[min(17.5rem,88vw)] flex-col gap-4 overflow-y-auto border-r bg-sidebar p-3 text-sidebar-foreground shadow-xl"
          >
            <div className="flex items-center justify-between px-1">
              <AppName />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label={t('sidebar.closeMenu')}
                className="rounded-md p-1.5 hover:bg-accent"
              >
                <X className="size-4" />
              </button>
            </div>
            <CompanySwitcher session={session} />
            <WalletChip session={session} />
            <div className="flex-1">
              <NavList session={session} onNavigate={() => setDrawerOpen(false)} />
            </div>
            <ShellFooter session={session} />
          </aside>
        </div>
      ) : null}

      {/* T54: modal global de aprovação de acesso de suporte (owner/admin; 16 §5). */}
      <SupportApprovalModal session={session} />
      {/* T100: aviso da plataforma em pop-up (14 §12–§14). */}
      <AnnouncementPopup session={session} />

      {/* T108: widget de chat de suporte (script de terceiros; nada no DOM do shell). */}
      <SupportWidget session={session} />

      {/* Barra inferior mobile (spec 18 §2.6). */}
      {isDesktop ? null : (
        <nav
          data-testid="shell-bottom-nav"
          aria-label={t('bottomNav.label')}
          className="fixed inset-x-0 bottom-0 z-40 grid h-16 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden"
          style={{ gridTemplateColumns: `repeat(${bottomItems.length + 1}, minmax(0, 1fr))` }}
        >
          {bottomItems.map((item) => {
            const to = item.to === 'home' ? home : item.to
            const path = to.split('?')[0]!
            const active = item.to === 'home' ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)
            const Icon = item.icon
            return (
              <Link
                key={item.id}
                to={path as never}
                data-testid={`bottom-nav-${item.id}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-w-0 flex-col items-center justify-center gap-0.5 text-[11px]',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden />
                <span className="truncate">{t(item.labelKey)}</span>
                {active ? <span className="absolute bottom-1 h-0.5 w-6 rounded bg-primary" aria-hidden /> : null}
              </Link>
            )
          })}
          <button
            type="button"
            data-testid="bottom-nav-more"
            onClick={() => setDrawerOpen((o) => !o)}
            aria-expanded={drawerOpen}
            className="flex flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
          >
            <MoreHorizontal className="size-5" aria-hidden />
            <span>{t('bottomNav.more')}</span>
          </button>
        </nav>
      )}
    </div>
  )
}
