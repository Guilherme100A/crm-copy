// Itens de navegação (sidebar desktop e drawer mobile), filtrados pela sessão (spec 18 §2.5).
import { Link, useRouterState } from '@tanstack/react-router'
// T107: indicador de queda no item Conexões.
import { DisconnectIndicator } from '@/features/shell-disconnect/indicator'
import { useT } from '@/i18n'
import type { Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { visibleSections } from '../access'
import type { NavItem } from '../nav'

const isActive = (pathname: string, to: string) => {
  const path = to.split('?')[0]!
  return pathname === path || pathname.startsWith(`${path}/`)
}

export function NavList({ session, collapsed = false, onNavigate }: { session: Session; collapsed?: boolean; onNavigate?: () => void }) {
  const t = useT()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const sections = visibleSections(session)

  const itemClass = (active: boolean) =>
    cn(
      'group relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
      'hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none',
      active ? 'bg-accent text-accent-foreground' : 'text-sidebar-foreground/80',
      collapsed && 'justify-center px-0',
    )

  const label = (item: NavItem) => t(item.labelKey)

  return (
    <nav aria-label={t('nav.label')} className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-1">
          {collapsed ? (
            <hr className="mx-3 my-1 border-border" />
          ) : (
            <div className="px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t(section.labelKey)}</div>
          )}
          {section.items.map((item) => {
            const Icon = item.icon
            const content = (
              <>
                <Icon className="size-4 shrink-0" aria-hidden />
                {collapsed ? <span className="sr-only">{label(item)}</span> : <span className="truncate">{label(item)}</span>}
                {!collapsed && item.badgeKey ? (
                  <span className="ml-auto rounded bg-primary/15 px-1.5 text-[10px] font-semibold text-primary uppercase">{t(item.badgeKey)}</span>
                ) : null}
                {item.id === 'connections' ? <DisconnectIndicator session={session} collapsed={collapsed} /> : null}
              </>
            )
            if (item.href) {
              return (
                <a
                  key={item.id}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`nav-item-${item.id}`}
                  title={collapsed ? label(item) : undefined}
                  className={itemClass(false)}
                >
                  {content}
                </a>
              )
            }
            const [to, query] = item.to!.split('?')
            const active = isActive(pathname, item.to!)
            return (
              <Link
                key={item.id}
                to={to as never}
                search={(query ? Object.fromEntries(new URLSearchParams(query)) : undefined) as never}
                data-testid={`nav-item-${item.id}`}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? label(item) : undefined}
                className={itemClass(active)}
                onClick={onNavigate}
              >
                {content}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
