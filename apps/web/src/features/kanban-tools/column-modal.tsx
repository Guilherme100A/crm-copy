// Modal Nova/Editar coluna (04 §2 `jge`): nome, cor (Automático + 8 cores), marcar como conversão e pré-visualização.
// Automático grava `accent_color: null` (a cor sai da posição, T70).
import { Check, Target } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { columnColor } from '@/features/crms/format'
import type { ColumnDto } from '@/features/crms/api'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { COLUMN_COLORS, columnApi, type ColumnInput } from './api'
import { fieldClass, ModalShell } from './dialog'

export const colorTestId = (color: string | null) => (color ? `kt-column-color-${color.slice(1).toLowerCase()}` : 'kt-column-color-auto')

export function ColumnModal({
  open,
  crmId,
  column,
  nextPosition,
  onClose,
  onSaved,
}: {
  open: boolean
  crmId: string
  /** `null` = criar. */
  column: ColumnDto | null
  /** Posição da coluna nova (cor automática da prévia). */
  nextPosition: number
  onClose: () => void
  onSaved: (column: ColumnDto) => void
}) {
  const t = useT('kanban-tools')
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [conversion, setConversion] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(column?.name ?? '')
    setColor(column?.accent_color ?? null)
    setConversion(column?.conversion_goal ?? false)
    setError(null)
  }, [open, column])

  const position = column?.position ?? nextPosition
  const preview = columnColor({ accent_color: color, position })
  const trimmed = name.trim()

  const save = async () => {
    if (!trimmed) {
      setError(t('column.nameRequired'))
      return
    }
    const input: ColumnInput = { name: trimmed, accent_color: color, conversion_goal: conversion }
    setPending(true)
    setError(null)
    try {
      onSaved(column ? await columnApi.update(crmId, column.id, input) : await columnApi.create(crmId, input))
      onClose()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <ModalShell open={open} onOpenChange={(o) => !o && onClose()} testId="kt-column-modal" title={column ? t('column.editTitle') : t('column.newTitle')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('column.name')}</span>
          <input data-testid="kt-column-name" className={fieldClass} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('column.color')}</legend>
          <div role="radiogroup" aria-label={t('column.color')} className="flex flex-wrap gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={color === null}
              data-testid={colorTestId(null)}
              data-color=""
              onClick={() => setColor(null)}
              className={cn(
                'h-8 rounded-full border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                color === null ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-accent',
              )}
            >
              {t('column.auto')}
            </button>
            {COLUMN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                data-testid={colorTestId(c)}
                data-color={c}
                onClick={() => setColor(c)}
                className="flex size-8 items-center justify-center rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: c, borderColor: color === c ? 'var(--color-foreground, #111)' : 'transparent' }}
              >
                {color === c ? <Check className="size-4 text-white" aria-hidden /> : null}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input data-testid="kt-column-conversion" type="checkbox" className="size-4" checked={conversion} onChange={(e) => setConversion(e.target.checked)} />
          <span>{t('column.conversion')}</span>
        </label>

        <div data-testid="kt-column-preview" className="rounded-lg border bg-muted/40 p-3" style={{ borderTop: `3px solid ${preview}` }}>
          <p className="text-xs text-muted-foreground">{t('column.preview')}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: preview }} aria-hidden />
            <span className="truncate text-sm font-semibold">{trimmed || t('column.namePlaceholder')}</span>
            {conversion ? <Target className="size-4 text-emerald-600" aria-label={t('column.conversion')} /> : null}
          </div>
        </div>

        {error ? (
          <p data-testid="kt-column-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" data-testid="kt-column-cancel" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" data-testid="kt-column-save" disabled={pending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </ModalShell>
  )
}
