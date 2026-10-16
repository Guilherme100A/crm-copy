// `/welcome` (02 §2; T78): saudação, marco e abas Vendas/Atendimento por permissão. Os filtros vivem na URL; o período
// é calculado no fuso da empresa. "Atualizar" pede recálculo (`force_refresh`) e grava a resposta no cache da consulta.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useI18n, useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { bootstrapKey, bootstrapQuery, companyTzQuery, dashboardQuery, DEFAULT_TZ, groupsApi, refreshDashboard, type FilterGroup } from './api'
import { FiltersBar } from './filters-bar'
import { timeIn } from './format'
import { DashboardHeader } from './header'
import { SalesPanel } from './sales-panel'
import { cleanSearch, dashboardQueryOf, tabOf, type DashboardSearch, type DashboardTab } from './search'
import { dashboardTab } from './tabs'

export function DashboardPage({ search, onSearch }: { search: DashboardSearch; onSearch: (next: DashboardSearch) => void }) {
  const t = useT('dashboard')
  const { locale } = useI18n()
  const qc = useQueryClient()
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const canSales = !!session && hasAny(session, ['dashboard.sales'])
  const tab = tabOf(search, canSales)
  const tzQ = useQuery(companyTzQuery(session?.company?.id ?? null))
  const tz = tzQ.data ?? DEFAULT_TZ
  // Sem o fuso ainda, as datas do preset sairiam no fuso errado: espera (ou segue no padrão se a consulta falhar).
  const tzReady = tzQ.isSuccess || tzQ.isError || !session?.company
  const bootstrap = useQuery(bootstrapQuery(locale))
  const params = useMemo(() => dashboardQueryOf(search, tz), [search, tz])
  const data = useQuery({ ...dashboardQuery(params), enabled: canSales && tab === 'sales' && tzReady })
  const [refreshing, setRefreshing] = useState(false)

  const set = (next: DashboardSearch) => onSearch(cleanSearch(next))

  const refresh = async () => {
    setRefreshing(true)
    try {
      const fresh = await refreshDashboard(params)
      qc.setQueryData(dashboardQuery(params).queryKey, fresh)
    } catch {
      notify('dashboard-refresh-error', t('common.error'))
    } finally {
      setRefreshing(false)
    }
  }

  const saveGroup = async (name: string) => {
    await groupsApi.create({ name, connection_ids: search.connection_ids ?? [], product_ids: search.product_ids ?? [] })
    await qc.invalidateQueries({ queryKey: bootstrapKey })
  }
  const deleteGroup = async (g: FilterGroup) => {
    try {
      await groupsApi.remove(g.id)
      if (search.group === g.id) set({ ...search, group: undefined })
      await qc.invalidateQueries({ queryKey: bootstrapKey })
    } catch {
      notify('dashboard-group-error', t('common.error'))
    }
  }

  const Attendance = dashboardTab('attendance')
  const tabs: DashboardTab[] = canSales ? ['sales', 'attendance'] : ['attendance']
  const computedAt = data.data?.computed_at ?? null

  return (
    <section data-testid="page-welcome" className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4">
      <div data-testid="dashboard" className="flex min-w-0 flex-col gap-4">
        {session ? (
          <DashboardHeader user={session.user} companyName={session.company?.name ?? ''} tz={tz} bootstrap={canSales ? bootstrap.data : bootstrap.data && { ...bootstrap.data, lifetime_revenue: undefined }} />
        ) : null}
        <div role="tablist" aria-label={t('tabs.label')} className="flex gap-1 border-b">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`dashboard-tab-${id}`}
              aria-selected={tab === id}
              onClick={() => set({ ...search, tab: id })}
              className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
        {tab === 'sales' ? (
          <div data-testid="dashboard-sales" role="tabpanel" className="flex min-w-0 flex-col gap-4">
            <FiltersBar
              search={search}
              onSearch={set}
              bootstrap={bootstrap.data}
              computedAt={computedAt}
              lastUpdated={computedAt ? timeIn(computedAt, tz, locale) : null}
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              onSaveGroup={saveGroup}
              onDeleteGroup={deleteGroup}
            />
            <SalesPanel data={data.data} loading={data.isFetching || data.isPending} />
          </div>
        ) : (
          <div data-testid="dashboard-attendance" role="tabpanel" className="flex min-w-0 flex-col gap-4">
            {Attendance ? (
              <Attendance connectionIds={search.connection_ids ?? []} />
            ) : (
              <p data-testid="dashboard-attendance-placeholder" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t('attendance.placeholder')}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
