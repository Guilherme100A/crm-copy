// Modal global de aprovação de acesso de suporte (16 §5 "Acesso de suporte", §8.4; AC-T54-05), montado no shell.
// Só owner/admin da empresa ativa. Carga inicial por `GET /api/support-access/requests` (pendentes) e, depois,
// os eventos `support_access.*` (handlers em `./realtime`, importado aqui de forma estática). Aprovar ou recusar
// tira o pedido da fila e o modal mostra o próximo; fechar dispensa só os pedidos já vistos.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import type { Session } from '@/lib/session'
import { notify } from '@/lib/toast'
import { companyGrantsKey, companySupportApi, pendingRequestsKey, pendingRequestsQuery, type SupportAccessRequestDto } from './api'
import { canReviewSupport, removeRequest, visibleQueue } from './queue'
import './realtime'

const NS = 'settings-support'

export function SupportApprovalModal({ session }: { session: Session }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const companyId = session.company?.id
  const enabled = canReviewSupport(session)
  const q = useQuery({ ...pendingRequestsQuery(companyId), enabled })
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState(false)
  const queue = enabled ? visibleQueue(q.data ?? [], dismissed) : []
  const current = queue[0]

  const decide = async (req: SupportAccessRequestDto, action: 'approve' | 'reject') => {
    setPending(true)
    try {
      if (action === 'approve') await companySupportApi.approve(req.id)
      else await companySupportApi.reject(req.id)
      notify(`support-approval-${action}d`, action === 'approve' ? t('approval.approved') : t('approval.rejected'))
      if (action === 'approve') void qc.invalidateQueries({ queryKey: companyGrantsKey(companyId) })
    } catch (err) {
      // Já decidido/cancelado por outra pessoa (409/404): some da fila do mesmo jeito.
      notify('support-approval-error', err instanceof HttpError ? err.message : t('common.error'))
      void qc.invalidateQueries({ queryKey: pendingRequestsKey(companyId) })
    } finally {
      qc.setQueryData<SupportAccessRequestDto[]>(pendingRequestsKey(companyId), (old) => (old ? removeRequest(old, req.id) : old))
      setPending(false)
    }
  }

  if (!current) return null
  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o && !pending) setDismissed((d) => new Set([...d, ...queue.map((r) => r.id)]))
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/40" />
        <Dialog.Popup
          data-testid="support-approval-modal"
          data-request-id={current.id}
          className="fixed top-1/2 left-1/2 z-[80] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" aria-hidden />
            <Dialog.Title className="flex-1 text-lg font-semibold">{t('approval.title')}</Dialog.Title>
            {queue.length > 1 ? (
              <span data-testid="support-approval-count" className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums">
                {t('approval.count', { n: queue.length })}
              </span>
            ) : null}
          </div>
          <Dialog.Description data-testid="support-approval-text" className="text-sm">
            {t('approval.body', { name: current.support_name, email: current.support_email })}
          </Dialog.Description>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              data-testid="support-approval-reject"
              disabled={pending}
              onClick={() => void decide(current, 'reject')}
            >
              {t('approval.reject')}
            </Button>
            <Button data-testid="support-approval-approve" disabled={pending} onClick={() => void decide(current, 'approve')}>
              {t('approval.approve')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
