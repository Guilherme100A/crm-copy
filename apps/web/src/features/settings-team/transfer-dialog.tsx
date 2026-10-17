// Transferir propriedade (16 §4, §5 Equipe 5; AC-T54-03): mostra as 4 consequências e, confirmado, chama
// `POST /api/team/:userId/transfer-ownership` (o owner atual vira admin; o alvo, um admin, vira o único owner).
import { Dialog } from '@base-ui/react/dialog'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { teamApi, type MemberDto } from './api'

const NS = 'settings-team'
export const TRANSFER_CONSEQUENCES = ['newOwner', 'youAdmin', 'billing', 'irreversible'] as const

export function TransferDialog({
  member,
  onClose,
  onDone,
}: {
  member: MemberDto
  onClose: () => void
  onDone: (r: { owner: MemberDto; previous_owner: MemberDto }) => Promise<void>
}) {
  const t = useT(NS)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setPending(true)
    setError(null)
    try {
      await onDone(await teamApi.transfer(member.user_id))
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !pending && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="transfer-dialog"
          role="alertdialog"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('transfer.title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground">
            {t('transfer.body', { name: member.user.name })}
          </Dialog.Description>
          <ul data-testid="transfer-consequences" className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {TRANSFER_CONSEQUENCES.map((c) => (
              <li key={c} data-testid={`transfer-consequence-${c}`}>
                {t(`transfer.consequences.${c}`, { name: member.user.name })}
              </li>
            ))}
          </ul>
          {error ? (
            <p data-testid="transfer-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" data-testid="transfer-cancel" disabled={pending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" data-testid="transfer-confirm" disabled={pending} onClick={() => void confirm()}>
              {t('transfer.confirm')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
