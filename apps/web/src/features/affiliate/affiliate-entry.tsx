// Item "Programa de afiliados" do rodapé do shell (SPEC T97; 13-afiliacao.md §1, §4; 18 §9.4). Só existe com a URL
// do portal (`GET /api/app-config`): sem ela não há botão nem modal. O clique abre o aviso de site externo;
// "Continuar" é um link `target=_blank rel="noopener noreferrer"` para o portal e fecha o modal.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Handshake } from 'lucide-react'
import { useState } from 'react'
import { buttonVariants } from '@/components/ui/button'
import { useT } from '@/i18n'
import { APP_NAME, cn } from '@/lib/utils'
import { appConfigQuery, portalUrlOf } from './api'

const NS = 'affiliate'
export const AFFILIATE_LINK_REL = 'noopener noreferrer'

export function AffiliateEntry({ collapsed = false }: { collapsed?: boolean }) {
  const t = useT(NS)
  const q = useQuery(appConfigQuery())
  const [open, setOpen] = useState(false)
  const url = portalUrlOf(q.data)
  if (!url) return null

  return (
    <>
      <button
        type="button"
        data-testid="affiliate-entry"
        onClick={() => setOpen(true)}
        aria-label={collapsed ? t('entry') : undefined}
        title={collapsed ? t('entry') : undefined}
        className={cn(
          'flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-accent',
          collapsed && 'justify-center px-0',
        )}
      >
        <Handshake className="size-4" aria-hidden />
        {collapsed ? null : <span className="truncate">{t('entry')}</span>}
      </button>
      {open ? (
        <Dialog.Root open onOpenChange={(o) => !o && setOpen(false)}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-[80] bg-black/40" />
            <Dialog.Popup
              data-testid="affiliate-modal"
              className="fixed top-1/2 left-1/2 z-[80] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
            >
              <div className="flex items-center gap-2">
                <Handshake className="size-5 text-primary" aria-hidden />
                <Dialog.Title className="flex-1 text-lg font-semibold">{t('modal.title')}</Dialog.Title>
              </div>
              <Dialog.Description data-testid="affiliate-modal-text" className="text-sm">
                {t('modal.body', { app: APP_NAME })}
              </Dialog.Description>
              <div className="flex flex-wrap justify-end gap-2">
                <Dialog.Close data-testid="affiliate-modal-cancel" className={buttonVariants({ variant: 'outline' })}>
                  {t('modal.cancel')}
                </Dialog.Close>
                <a
                  data-testid="affiliate-modal-continue"
                  href={url}
                  target="_blank"
                  rel={AFFILIATE_LINK_REL}
                  onClick={() => setOpen(false)}
                  className={buttonVariants()}
                >
                  {t('modal.continue')}
                  <ExternalLink aria-hidden />
                </a>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  )
}
