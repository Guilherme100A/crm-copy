// Aba `support_access` do hub (16 §2.1, §5 "Acesso de suporte"; só owner/admin): concessões ativas (suporte,
// e-mail, expira em) com "Revogar acesso". Os pedidos pendentes são decididos no modal global do shell.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, LoadError, Loading, useSession } from '@/features/settings-company/ui'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { companyGrantsKey, companyGrantsQuery, companySupportApi, pendingRequestsQuery, type SupportAccessGrantDto } from './api'
import { canReviewSupport } from './queue'

const NS = 'settings-support'

export default function SupportAccessTab() {
  const t = useT(NS)
  const session = useSession()
  const qc = useQueryClient()
  const desktop = useIsDesktop()
  const companyId = session?.company?.id
  const allowed = !!session && canReviewSupport(session)
  const grants = useQuery({ ...companyGrantsQuery(companyId), enabled: allowed })
  const pendingCount = useQuery({ ...pendingRequestsQuery(companyId), enabled: allowed }).data?.length ?? 0
  const [revoking, setRevoking] = useState<SupportAccessGrantDto | null>(null)

  if (!session) return <Loading />
  if (!allowed || (grants.error instanceof HttpError && grants.error.status === 403))
    return (
      <div data-testid="support-denied" className="rounded-lg border border-dashed p-6 text-center">
        <p className="font-medium">{t('denied.title')}</p>
        <p className="text-sm text-muted-foreground">{t('denied.body')}</p>
      </div>
    )

  const fmt = (iso: string) => new Date(iso).toLocaleString()
  const rows = grants.data ?? []
  const revokeButton = (g: SupportAccessGrantDto) => (
    <Button
      variant="outline"
      size="sm"
      className="text-destructive"
      data-testid={`support-grants-revoke-${g.support_user_id}`}
      onClick={() => setRevoking(g)}
    >
      <ShieldOff aria-hidden /> {t('grants.revoke')}
    </Button>
  )

  return (
    <section data-testid="support-settings" className="flex min-w-0 flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        {pendingCount > 0 ? (
          <p data-testid="support-pending-count" className="mt-1 text-sm">
            {t('pendingCount', { n: pendingCount })}
          </p>
        ) : null}
      </header>
      {grants.isPending ? (
        <Loading />
      ) : grants.isError ? (
        <LoadError testId="support-grants-error" onRetry={() => void grants.refetch()} />
      ) : rows.length === 0 ? (
        <p data-testid="support-grants-empty" className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('grants.empty')}
        </p>
      ) : desktop ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table data-testid="support-grants-table" className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t('grants.support')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('grants.email')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('grants.expiresAt')}</th>
                <th scope="col" className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((g) => (
                <tr key={g.id} data-testid={`support-grants-item-${g.support_user_id}`}>
                  <td className="px-3 py-2 font-medium">{g.name}</td>
                  <td className="px-3 py-2 break-all">{g.email}</td>
                  <td className="px-3 py-2 tabular-nums">{fmt(g.expires_at)}</td>
                  <td className="px-3 py-1 text-right">{revokeButton(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul data-testid="support-grants-cards" className="flex flex-col gap-2">
          {rows.map((g) => (
            <li key={g.id} data-testid={`support-grants-item-${g.support_user_id}`} className="flex flex-col gap-2 rounded-xl border bg-card p-3">
              <div className="font-medium">{g.name}</div>
              <div className="text-xs break-all text-muted-foreground">{g.email}</div>
              <div className="text-xs">{t('grants.expiresIn', { at: fmt(g.expires_at) })}</div>
              <div>{revokeButton(g)}</div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!revoking}
        testId="support-revoke-confirm"
        title={t('grants.revokeTitle')}
        body={revoking ? t('grants.revokeBody', { name: revoking.name }) : ''}
        confirmLabel={t('grants.revoke')}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return
          try {
            await companySupportApi.revoke(revoking.support_user_id)
            qc.setQueryData<SupportAccessGrantDto[]>(companyGrantsKey(companyId), (old) =>
              old?.filter((g) => g.support_user_id !== revoking.support_user_id),
            )
            notify('support-revoked', t('grants.revoked'))
            setRevoking(null)
          } catch (err) {
            notify('support-error', err instanceof HttpError ? err.message : t('common.error'))
          }
        }}
      />
    </section>
  )
}
