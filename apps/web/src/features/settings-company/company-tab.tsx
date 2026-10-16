// Aba `accounts` do hub (16 §2.1/§2.2): sub-abas Dados Corporativos | Departamentos | Horários de Trabalho em
// `?company_tab=`. Sub-aba ausente, inválida ou sem permissão → a primeira permitida (replace).
import { useNavigate, useSearch } from '@tanstack/react-router'
import { lazy, Suspense, useEffect, useMemo } from 'react'
import { useT } from '@/i18n'
import { hasAny } from '@/lib/session'
import { cn } from '@/lib/utils'
import { COMPANY_TABS, resolveCompanyTab, type CompanyTab } from './company'
import { InfoPanel } from './info-panel'
import { Loading, useSession } from './ui'

const DepartmentsPanel = lazy(() => import('@/features/settings-departments/departments-panel'))
const HoursPanel = lazy(() => import('@/features/settings-hours/hours-panel'))

export default function CompanySettingsTab() {
  const t = useT('settings-company')
  const session = useSession()
  const search = useSearch({ strict: false }) as { company_tab?: string }
  const navigate = useNavigate()
  const allowed = useMemo(
    () => (session ? COMPANY_TABS.filter((x) => hasAny(session, x.permissions)).map((x) => x.id) : []),
    [session],
  )
  const active = resolveCompanyTab(search.company_tab, allowed)

  useEffect(() => {
    if (active && active !== search.company_tab)
      void navigate({
        to: '/settings',
        search: (s: Record<string, unknown>) => ({ ...s, company_tab: active }),
        replace: true,
      } as never)
  }, [active, search.company_tab, navigate])

  const go = (id: CompanyTab) =>
    void navigate({ to: '/settings', search: (s: Record<string, unknown>) => ({ ...s, company_tab: id }) } as never)
  const companyId = session?.company?.id

  return (
    <section data-testid="company-settings" className="flex min-w-0 flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <div role="tablist" aria-label={t('title')} className="flex gap-1 overflow-x-auto border-b">
        {COMPANY_TABS.filter((x) => allowed.includes(x.id)).map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === active}
            data-testid={`company-tab-${x.id}`}
            onClick={() => go(x.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap',
              x.id === active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(x.labelKey)}
          </button>
        ))}
      </div>
      {!companyId || !active ? (
        session ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t('common.forbidden')}</p>
        ) : (
          <Loading />
        )
      ) : (
        <div role="tabpanel">
          {active === 'info' ? (
            <InfoPanel companyId={companyId} />
          ) : (
            <Suspense fallback={<Loading />}>
              {active === 'departments' ? <DepartmentsPanel /> : <HoursPanel />}
            </Suspense>
          )}
        </div>
      )}
    </section>
  )
}
