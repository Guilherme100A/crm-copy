// Seletor de modelo do agente (AC-T88-03): modelos do catálogo agrupados por provedor, com a disponibilidade da
// empresa (`GET /api/ai-agents/model-options`: chave da empresa ou da plataforma). Indisponível fica desabilitado com
// "sem chave". "Padrão do motor" = sem modelo explícito (o preset do motor escolhido vale).
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { modelOptionsQuery, type ModelRef } from './api'
import { modelOptions } from './form'
import { FieldError } from './ui'

export function ModelSelect({
  value,
  onChange,
  disabled,
  error,
}: {
  value: ModelRef | null
  onChange: (v: ModelRef | null) => void
  disabled?: boolean
  error?: string
}) {
  const t = useT('agents')
  const q = useQuery(modelOptionsQuery())
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const options = modelOptions(q.data, value)
  const providerOk = new Map((q.data?.providers ?? []).map((p) => [p.provider, p.available]))
  const currentUnavailable = !!value && providerOk.get(value.provider) === false

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (v: ModelRef | null) => {
    onChange(v)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium">{t('model.label')}</span>
      <button
        type="button"
        data-testid="agent-model-select"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={error !== undefined ? true : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full max-w-md min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate">
          {value ? `${t(`providers.${value.provider}`)} · ${value.model}` : t('model.default')}
        </span>
        {currentUnavailable ? <span className="shrink-0 text-xs text-destructive">{t('model.noKey')}</span> : null}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <p className="text-xs text-muted-foreground">{t('model.hint')}</p>
      {error !== undefined ? <FieldError path="model" message={error} /> : null}
      {open ? (
        <ul
          role="listbox"
          data-testid="agent-model-options"
          aria-label={t('model.label')}
          className="absolute top-16 left-0 z-30 flex max-h-80 w-full max-w-md flex-col overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
        >
          <li
            role="option"
            data-testid="agent-model-option-default"
            aria-selected={value === null}
            tabIndex={0}
            onClick={() => pick(null)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick(null)}
            className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 hover:bg-accent"
          >
            <span className="flex-1">{t('model.default')}</span>
            {value === null ? <Check className="size-4" aria-hidden /> : null}
          </li>
          {q.isPending ? <li className="px-3 py-2 text-muted-foreground">{t('common.loading')}</li> : null}
          {!q.isPending && options.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">{t('model.empty')}</li>
          ) : null}
          {options.map((m) => {
            const selected = !!value && value.provider === m.provider && value.model === m.model
            return (
              <li
                key={`${m.provider}/${m.model}`}
                role="option"
                data-testid="agent-model-option"
                data-provider={m.provider}
                data-model={m.model}
                data-available={m.available ? 'true' : 'false'}
                aria-selected={selected}
                aria-disabled={m.available ? undefined : true}
                tabIndex={m.available ? 0 : -1}
                onClick={() => m.available && pick({ provider: m.provider, model: m.model })}
                onKeyDown={(e) =>
                  m.available && (e.key === 'Enter' || e.key === ' ') && pick({ provider: m.provider, model: m.model })
                }
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded px-3 py-2',
                  m.available ? 'cursor-pointer hover:bg-accent' : 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {t(`providers.${m.provider}`)}
                </span>
                <span className="min-w-0 flex-1 truncate">{m.model}</span>
                {!m.available ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <KeyRound className="size-3" aria-hidden /> {t('model.noKey')}
                  </span>
                ) : selected ? (
                  <Check className="size-4 shrink-0" aria-hidden />
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
