// Pix (spec 03 F38, adaptado: SPEC 3.8 manda como texto): chave, recebedor e valor opcional; a chave fica numa linha
// própria da mensagem (o contato copia) e a prévia tem "Copiar chave".
import { Dialog } from '@base-ui/react/dialog'
import { Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { parseAmountCents } from './rules'

export interface PixInput {
  key: string
  name: string | null
  amount_cents: number | null
}

/** O mesmo texto que o servidor monta (`pixText` da T49), para a prévia. */
export function pixPreview(p: PixInput, locale = 'pt-BR'): string {
  const lines = ['*Pagamento via Pix*', `Chave Pix: ${p.key}`]
  if (p.name) lines.push(`Recebedor: ${p.name}`)
  if (p.amount_cents != null) lines.push(`Valor: ${(p.amount_cents / 100).toLocaleString(locale, { style: 'currency', currency: 'BRL' })}`)
  return lines.join('\n')
}

export function PixDialog({ open, onOpenChange, onSend }: { open: boolean; onOpenChange: (o: boolean) => void; onSend: (p: PixInput) => void }) {
  const t = useT('chat-composer')
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setKey('')
      setName('')
      setAmount('')
      setError(null)
    }
  }, [open])

  const cents = parseAmountCents(amount)
  const input: PixInput = { key: key.trim(), name: name.trim() || null, amount_cents: cents === null || Number.isNaN(cents) ? null : cents }

  const submit = () => {
    if (!input.key) return setError(t('pix.keyRequired'))
    if (cents !== null && Number.isNaN(cents)) return setError(t('pix.amountInvalid'))
    onSend(input)
    onOpenChange(false)
  }

  const copy = () => {
    if (!input.key) return
    void navigator.clipboard
      ?.writeText(input.key)
      .then(() => notify('chat-composer-pix-copied', t('pix.copied')))
      .catch(() => undefined)
  }

  const field = 'h-9 w-full rounded-md border bg-background px-3 text-sm'
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid="chat-composer-pix-modal"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('pix.title')}</Dialog.Title>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('pix.key')}</span>
            <input data-testid="chat-composer-pix-key" value={key} onChange={(e) => setKey(e.target.value)} className={field} maxLength={200} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('pix.name')}</span>
            <input data-testid="chat-composer-pix-name" value={name} onChange={(e) => setName(e.target.value)} className={field} maxLength={200} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('pix.amount')}</span>
            <input data-testid="chat-composer-pix-amount" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
          </label>
          {input.key ? (
            <div data-testid="chat-composer-pix-preview" className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              <span className="min-w-0 flex-1 break-all">{pixPreview(input)}</span>
              <button type="button" data-testid="chat-composer-pix-copy" onClick={copy} aria-label={t('pix.copy')} className="rounded p-1 hover:bg-background">
                <Copy className="size-4" aria-hidden />
              </button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" data-testid="chat-composer-pix-error" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button data-testid="chat-composer-pix-submit" onClick={submit}>
              {t('pix.submit')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
