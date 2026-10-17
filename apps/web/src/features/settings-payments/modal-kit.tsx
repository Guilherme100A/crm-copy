// Peças comuns dos modais de Vendas/Rastreamento (T114): moldura do formulário (mesmo visual do modal de chave de IA da
// T59), campo de segredo mascarado com mostrar/ocultar e a confirmação de exclusão com a lista de fluxos que usam o
// registro (409 → aviso e, quando o servidor aceita, "Excluir mesmo assim").
import { Dialog } from '@base-ui/react/dialog'
import { Eye, EyeOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { inputClass } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'

export const NS = 'settings-payments'

const popupCls =
  'fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background shadow-xl outline-none'

export function FormShell({
  testid,
  mode,
  title,
  onClose,
  onSubmit,
  pending,
  error,
  children,
}: {
  testid: string
  mode: 'create' | 'edit'
  title: string
  onClose: () => void
  onSubmit: () => void
  pending: boolean
  error: string | null
  children: ReactNode
}) {
  const t = useT(NS)
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid={`${testid}-editor`} data-mode={mode} className={popupCls}>
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit()
            }}
          >
            <Dialog.Title className="border-b px-5 py-4 text-lg font-semibold">{title}</Dialog.Title>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">{children}</div>
            {error ? (
              <p data-testid={`${testid}-error`} role="alert" className="px-5 pb-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t px-5 py-3">
              <Button variant="outline" data-testid={`${testid}-cancel`} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" data-testid={`${testid}-save`} disabled={pending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Campo de segredo: sempre `password` por padrão, nunca preenchido com o valor salvo (só a dica no placeholder). */
export function SecretInput({
  id,
  testid,
  value,
  onChange,
  placeholder,
  maxLength,
  invalid,
}: {
  id: string
  testid: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  maxLength: number
  invalid: boolean
}) {
  const t = useT(NS)
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input
        id={id}
        data-testid={testid}
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        maxLength={maxLength + 20}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputClass, 'pr-10 font-mono')}
      />
      <button
        type="button"
        data-testid={`${testid}-toggle`}
        aria-label={t(shown ? 'common.hide' : 'common.show')}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent"
      >
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  )
}

export function DeleteShell({
  testid,
  title,
  body,
  flows,
  warning,
  canForce,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  testid: string
  title: string
  body: string
  /** Fluxos ativos que usam o registro (409). */
  flows: { id: string; name: string }[] | null
  warning: string | null
  /** O servidor aceita `?force=1`. */
  canForce: boolean
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (force: boolean) => void
}) {
  const t = useT(NS)
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup data-testid={`${testid}-delete`} className={cn(popupCls, 'gap-4 p-5')}>
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{body}</p>
          {flows ? (
            <div
              data-testid={`${testid}-delete-in-use`}
              role="alert"
              className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-medium text-destructive">{warning ?? t('delete.inUse')}</p>
              <ul className="list-disc pl-5">
                {flows.map((f) => (
                  <li key={f.id} data-testid={`${testid}-delete-flow-${f.id}`}>
                    {f.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <p role="alert" data-testid={`${testid}-delete-error`} className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" data-testid={`${testid}-delete-cancel`} onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            {flows ? (
              canForce ? (
                <Button
                  variant="destructive"
                  data-testid={`${testid}-delete-force`}
                  disabled={pending}
                  onClick={() => onConfirm(true)}
                >
                  {t('delete.force')}
                </Button>
              ) : null
            ) : (
              <Button
                variant="destructive"
                data-testid={`${testid}-delete-confirm`}
                disabled={pending}
                onClick={() => onConfirm(false)}
              >
                {t('delete.confirm')}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
