// Peças da tela de fontes de venda: campo somente leitura com copiar (URL, segredo, id do produto) e confirmação com
// rótulo próprio (rotacionar token, trocar/remover segredo, excluir fonte). Testids `<prefixo>-<coisa>`.
import { Dialog } from '@base-ui/react/dialog'
import { Check, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'

export const NS = 'settings-sale-sources'

export function CopyField({
  testid,
  value,
  label,
  mono = true,
}: {
  testid: string
  value: string
  label: string
  mono?: boolean
}) {
  const t = useT(NS)
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex min-w-0 gap-2">
      <input
        data-testid={testid}
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className={cn(
          'h-9 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
          mono && 'font-mono',
        )}
      />
      <Button
        variant="outline"
        size="sm"
        className="h-9 shrink-0"
        data-testid={`${testid}-copy`}
        disabled={!value}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
            notify(`${testid}-copied`, t('copy.done'))
          } catch {
            notify(`${testid}-copy-error`, t('copy.error'))
          }
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{' '}
        <span className="max-sm:sr-only">{t('copy.action')}</span>
      </Button>
    </div>
  )
}

export function ConfirmAction({
  prefix,
  open,
  title,
  body,
  confirmLabel,
  destructive = true,
  onCancel,
  onConfirm,
  children,
}: {
  prefix: string
  open: boolean
  title: string
  body: string
  confirmLabel: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
  children?: ReactNode
}) {
  const t = useT(NS)
  const [pending, setPending] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid={`${prefix}-confirm`}
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{body}</p>
          {children}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid={`${prefix}-confirm-cancel`} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              data-testid={`${prefix}-confirm-ok`}
              disabled={pending}
              onClick={async () => {
                setPending(true)
                try {
                  await onConfirm()
                } finally {
                  setPending(false)
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Section({
  title,
  hint,
  children,
  testid,
}: {
  title: string
  hint?: string
  children: ReactNode
  testid?: string
}) {
  return (
    <section data-testid={testid} className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}
