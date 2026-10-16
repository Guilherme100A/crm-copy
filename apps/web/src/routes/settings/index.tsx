// Hub `/settings?tab=` (spec 16 §2.1): abas vindas do registro `features/settings/tabs.ts`, filtradas pela sessão.
// Aba ausente ou não permitida → a primeira visível (replace). As tarefas de configurações registram as abas.
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useMemo } from 'react'
import { z } from 'zod'
import { SETTINGS_GROUPS, SETTINGS_TABS, type SettingsTab } from '@/features/settings/tabs'
import { useT } from '@/i18n'
import { hasAny, type Session } from '@/lib/session'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/settings/')({
  validateSearch: z.object({ tab: z.string().optional().catch(undefined), company_tab: z.string().optional().catch(undefined) }),
  component: SettingsHub,
})

const lazyCache = new Map<string, ReturnType<typeof lazy>>()
const lazyTab = (tab: SettingsTab) => {
  let C = lazyCache.get(tab.id)
  if (!C) lazyCache.set(tab.id, (C = lazy(tab.load)))
  return C
}

function SettingsHub() {
  const t = useT()
  const { session } = Route.useRouteContext() as { session: Session }
  const { tab } = Route.useSearch()
  const navigate = useNavigate()
  const tabs = useMemo(
    () => SETTINGS_TABS.filter((x) => !(session.isSupport && x.hiddenForSupport) && hasAny(session, x.permissions)),
    [session],
  )
  const active = tabs.find((x) => x.id === tab) ?? tabs[0]

  useEffect(() => {
    if (active && active.id !== tab) void navigate({ to: '/settings', search: (s: Record<string, unknown>) => ({ ...s, tab: active.id }), replace: true } as never)
  }, [active, tab, navigate])

  return (
    <section data-testid="page-settings" className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('pages.settings')}</h1>
      {tabs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">{t('pages.settingsEmpty')}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <nav aria-label={t('pages.settingsTabs')} className="flex gap-1 overflow-x-auto lg:w-56 lg:flex-col">
            {SETTINGS_GROUPS.map((g) =>
              tabs
                .filter((x) => x.group === g)
                .map((x) => (
                  <Link
                    key={x.id}
                    to={'/settings' as never}
                    search={{ tab: x.id } as never}
                    data-testid={`settings-tab-${x.id}`}
                    className={cn('rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-accent', x.id === active?.id && 'bg-accent font-medium')}
                  >
                    {t(x.labelKey)}
                  </Link>
                )),
            )}
          </nav>
          <div className="min-w-0 flex-1">
            {active ? (
              <Suspense fallback={<div className="h-32 animate-pulse rounded-lg bg-muted" />}>
                {(() => {
                  const C = lazyTab(active)
                  return <C />
                })()}
              </Suspense>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}
