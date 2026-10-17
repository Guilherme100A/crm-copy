// Hub `/admin?tab=` (20 §2; AC-T100-01): menu lateral por grupo (Plataforma, Infraestrutura, Produto), aba inválida
// ou escondida → "Visão geral" com replace. Cada aba guarda busca/página no próprio estado: trocar de aba desmonta a
// anterior e zera os dois. A aba Sessões some no modo extensão (sonda `GET /api/admin/wa/sessions` → 404).
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, type ComponentType } from 'react'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { AccountsTab } from './accounts-tab'
import { AiTab } from './ai-tab'
import { AnnouncementsTab, BannersTab } from './announcements-tab'
import { adminWaSessionsQuery } from './api'
import { HealthTab, SessionsTab } from './infra-tabs'
import { OverviewTab } from './overview-tab'
import { ADMIN_GROUPS, ADMIN_TABS, resolveAdminTab, visibleAdminTabs, type AdminTabId } from './rules'
import { NS } from './ui'
import { UsersTab } from './users-tab'

const PANELS: Record<AdminTabId, ComponentType> = {
  overview: OverviewTab,
  users: UsersTab,
  accounts: AccountsTab,
  announcements: AnnouncementsTab,
  banners: BannersTab,
  health: HealthTab,
  sessions: SessionsTab,
  ai: AiTab,
}

/** Modo extensão = a rota das sessões não existe (404). Outros erros (gateway fora) mantêm a aba, com o erro nela. */
export const isExtensionMode = (err: unknown) => err instanceof HttpError && err.status === 404

export function AdminPage({ tab }: { tab: string | undefined }) {
  const t = useT(NS)
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const probe = useQuery(adminWaSessionsQuery())
  // Enquanto a sonda não volta, a aba fica (o `?tab=sessions` só é recusado com o 404).
  const sessionsAvailable = !isExtensionMode(probe.error)
  const visible = useMemo(() => visibleAdminTabs({ sessionsAvailable }), [sessionsAvailable])
  const active = resolveAdminTab(tab, visible)
  useEffect(() => {
    if (active === tab) return
    void navigate({ to: '/admin', search: (s: Record<string, unknown>) => ({ ...s, tab: active }), replace: true } as never)
  }, [active, tab, navigate])

  const Panel = PANELS[active]
  return (
    <section data-testid="page-admin" className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <div className="flex flex-col gap-4 lg:flex-row">
        {isDesktop ? (
          <nav aria-label={t('tabsLabel')} className="flex shrink-0 flex-col gap-3 lg:w-56">
            {ADMIN_GROUPS.map((g) => {
              const items = ADMIN_TABS.filter((x) => x.group === g && visible.includes(x.id))
              if (items.length === 0) return null
              return (
                <div key={g} className="flex flex-col gap-1">
                  <span className="px-3 text-xs font-medium text-muted-foreground uppercase">{t(`groups.${g}`)}</span>
                  {items.map((x) => (
                    <Link
                      key={x.id}
                      to={'/admin' as never}
                      search={{ tab: x.id } as never}
                      data-testid={`admin-tab-${x.id}`}
                      aria-current={x.id === active ? 'page' : undefined}
                      className={cn('rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent', x.id === active && 'bg-accent font-medium')}
                    >
                      {t(`tabs.${x.id}`)}
                    </Link>
                  ))}
                </div>
              )
            })}
          </nav>
        ) : (
          <select
            data-testid="admin-tab-select"
            aria-label={t('tabsLabel')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={active}
            onChange={(e) => void navigate({ to: '/admin', search: { tab: e.target.value } } as never)}
          >
            {ADMIN_GROUPS.map((g) => (
              <optgroup key={g} label={t(`groups.${g}`)}>
                {ADMIN_TABS.filter((x) => x.group === g && visible.includes(x.id)).map((x) => (
                  <option key={x.id} value={x.id} data-testid={`admin-tab-option-${x.id}`}>
                    {t(`tabs.${x.id}`)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <div className="min-w-0 flex-1">
          <Panel key={active} />
        </div>
      </div>
    </section>
  )
}
