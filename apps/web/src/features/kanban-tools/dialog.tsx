// Base dos modais do kanban (Base UI Dialog) + confirmação de exclusão + permissões da sessão (T91: effective_permissions).
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'

export const popupClass =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none'
export const fieldClass = 'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function ModalShell({
  open,
  onOpenChange,
  testId,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  testId: string
  title: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid={testId} className={popupClass}>
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export interface ConfirmRequest {
  title: string
  body: string
  action: string
  run: () => Promise<void>
}

/** Confirmação de exclusão (quadro, coluna). */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const t = useT('kanban-tools')
  const [pending, setPending] = useState(false)
  return (
    <ModalShell open={!!request} onOpenChange={(o) => !o && onClose()} testId="kt-confirm" title={request?.title ?? ''}>
      <p className="text-sm text-muted-foreground">{request?.body}</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="kt-confirm-cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          data-testid="kt-confirm-ok"
          disabled={pending}
          onClick={async () => {
            if (!request) return
            setPending(true)
            try {
              await request.run()
              onClose()
            } catch {
              // o chamador avisa o erro; o diálogo continua aberto para tentar de novo
            } finally {
              setPending(false)
            }
          }}
        >
          {request?.action}
        </Button>
      </div>
    </ModalShell>
  )
}

/** `can('kanban.edit')` pela sessão (dono tem tudo). */
export function useCan(): (...keys: string[]) => boolean {
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  return (...keys: string[]) => !!session && hasAny(session, keys)
}
