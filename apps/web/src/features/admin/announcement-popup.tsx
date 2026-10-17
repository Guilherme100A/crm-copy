// Pop-up de aviso no app do cliente (14 §12–§14; AC-T100-03): mostra o aviso ativo de maior prioridade que este
// usuário ainda não fechou neste navegador. "Fechar" só oculta localmente (não chama API); o próximo aparece em
// seguida. Montado no shell (T23); fora de `/admin`, onde o operador gerencia os avisos.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle2, ExternalLink, Info, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import type { Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { clientAnnouncementsQuery } from './api'
import { dismissAnnouncement, nextAnnouncement, readDismissed, type AnnouncementType } from './rules'
import { NS } from './ui'

const ICONS: Record<AnnouncementType, typeof Info> = { info: Info, warning: AlertTriangle, error: XCircle, success: CheckCircle2 }
const TONES: Record<AnnouncementType, string> = {
  info: 'text-sky-600 dark:text-sky-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
  success: 'text-emerald-600 dark:text-emerald-400',
}

export function AnnouncementPopup({ session }: { session: Session }) {
  const companyId = session.company?.id ?? null
  const onAdmin = useRouterState({ select: (s) => s.location.pathname === '/admin' || s.location.pathname.startsWith('/admin/') })
  const q = useQuery({ ...clientAnnouncementsQuery(companyId ?? ''), enabled: !!companyId && !session.isSupport })
  const [dismissed, setDismissed] = useState(() => readDismissed(session.user.id))
  const current = onAdmin ? null : nextAnnouncement(q.data ?? [], dismissed)
  if (!current) return null
  return <PopupDialog key={current.id} item={current} onClose={() => setDismissed(dismissAnnouncement(session.user.id, current.id))} />
}

function PopupDialog({
  item,
  onClose,
}: {
  item: { id: string; title: string; message: string; image_url: string | null; url: string | null; announcement_type: AnnouncementType }
  onClose: () => void
}) {
  const t = useT(NS)
  const Icon = ICONS[item.announcement_type] ?? Info
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/40" />
        <Dialog.Popup
          data-testid="admin-announcement-popup"
          data-announcement-id={item.id}
          data-type={item.announcement_type}
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <div className="flex items-start gap-3">
            <Icon className={cn('mt-0.5 size-5 shrink-0', TONES[item.announcement_type])} aria-hidden />
            <Dialog.Title data-testid="admin-announcement-popup-title" className="min-w-0 flex-1 text-lg font-semibold break-words">
              {item.title}
            </Dialog.Title>
          </div>
          {item.image_url ? (
            <img data-testid="admin-announcement-popup-image" src={item.image_url} alt="" className="max-h-64 w-full rounded-md border object-contain" />
          ) : null}
          <Dialog.Description data-testid="admin-announcement-popup-message" className="text-sm whitespace-pre-line break-words text-muted-foreground">
            {item.message}
          </Dialog.Description>
          <div className="flex justify-end gap-2">
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="admin-announcement-popup-link"
                className="inline-flex h-9 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                <ExternalLink className="size-4" aria-hidden /> {t('popup.open')}
              </a>
            ) : null}
            <Button data-testid="admin-announcement-popup-close" onClick={onClose}>
              {t('popup.close')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
