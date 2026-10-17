// Aba Empresas (20 §3.2; AC-T100-02): lista paginada (20) com busca (debounce 450 ms), ativar/desativar com
// confirmação e atalho para recarregar/ajustar os créditos de IA da empresa (AC-T100-04).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Power } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DataList, Pager, SearchBox, TabHeader, useDebounced } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { ADMIN_KEY, adminApi, adminCompaniesQuery, type AdminCompanyDto } from './api'
import { CreditsDialog, type CreditsTarget } from './credits-dialog'
import { ADMIN_SEARCH_DEBOUNCE_MS } from './rules'
import { ConfirmAction, fmtDate, NS, StatusBadge } from './ui'

const P = 'admin-accounts'

export function AccountsTab() {
  const t = useT(NS)
  const { locale } = useI18n()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const applied = useDebounced(search.trim(), ADMIN_SEARCH_DEBOUNCE_MS)
  useEffect(() => setPage(1), [applied])
  const q = useQuery(adminCompaniesQuery(page, applied))
  const [toggling, setToggling] = useState<AdminCompanyDto | null>(null)
  const [credits, setCredits] = useState<CreditsTarget | null>(null)
  const toggle = useMutation({
    mutationFn: (c: AdminCompanyDto) => adminApi.setCompanyActive(c.id, !c.active),
    onSuccess: async (_r, c) => {
      await qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'companies'] })
      notify('admin-account-saved', t(c.active ? 'accounts.deactivated' : 'accounts.activated'))
      setToggling(null)
    },
    onError: () => notify('admin-error', t('common.saveFailed')),
  })

  return (
    <div data-testid="admin-panel-accounts" className="flex flex-col gap-4">
      <TabHeader prefix={P} title={t('tabs.accounts')} subtitle={t('accounts.subtitle')} canCreate={false} newLabel="" onNew={() => undefined} />
      <SearchBox prefix={P} value={search} onChange={setSearch} placeholder={t('accounts.search')} />
      <DataList
        prefix={P}
        rows={q.data?.items ?? []}
        rowId={(c) => c.id}
        status={q.status}
        empty={applied ? t('common.noResults') : t('accounts.empty')}
        title={(c) => c.name}
        canEdit={() => false}
        canDelete={() => false}
        onEdit={() => undefined}
        columns={[
          { id: 'name', header: t('accounts.name'), cell: (c) => <span data-testid={`${P}-item-name-${c.id}`}>{c.name}</span> },
          { id: 'owner', header: t('accounts.ownerEmail'), cell: (c) => c.owner_email ?? '—' },
          { id: 'users', header: t('accounts.users'), cell: (c) => c.users_count },
          {
            id: 'status',
            header: t('accounts.status'),
            cell: (c) => (
              <StatusBadge ok={c.active} testId={`${P}-item-status-${c.id}`} label={t(c.active ? 'accounts.active' : 'accounts.inactive')} />
            ),
          },
          { id: 'created', header: t('common.createdAt'), cell: (c) => fmtDate(c.created_at, locale) },
          {
            id: 'actions',
            header: t('common.actions'),
            cell: (c) => (
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`${P}-item-credits-${c.id}`}
                  onClick={() => setCredits({ companyId: c.id, companyName: c.name, mode: 'topup' })}
                >
                  <Coins aria-hidden /> {t('credits.topup')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`${P}-item-adjust-${c.id}`}
                  onClick={() => setCredits({ companyId: c.id, companyName: c.name, mode: 'adjust' })}
                >
                  {t('credits.adjust')}
                </Button>
                <Button variant="ghost" size="sm" data-testid={`${P}-item-toggle-${c.id}`} onClick={() => setToggling(c)}>
                  <Power aria-hidden /> {t(c.active ? 'accounts.deactivate' : 'accounts.activate')}
                </Button>
              </div>
            ),
          },
        ]}
      />
      <Pager prefix={P} meta={q.data?.page} onPage={setPage} />
      <ConfirmAction
        prefix={P}
        open={!!toggling}
        title={t(toggling?.active ? 'accounts.deactivateTitle' : 'accounts.activateTitle')}
        body={t(toggling?.active ? 'accounts.deactivateBody' : 'accounts.activateBody', { name: toggling?.name ?? '' })}
        confirmLabel={t('common.confirm')}
        destructive={!!toggling?.active}
        onCancel={() => setToggling(null)}
        onConfirm={async () => {
          if (toggling) await toggle.mutateAsync(toggling).catch(() => undefined)
        }}
      />
      {credits ? <CreditsDialog target={credits} onClose={() => setCredits(null)} /> : null}
    </div>
  )
}
