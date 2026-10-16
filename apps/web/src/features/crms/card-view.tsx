// Card do quadro (04 §2 "Card"): avatar com badge de não lidas, nome, telefone formatado, etiquetas, prévia e valor.
// "Mover para…" leva o card ao fim de outra coluna (alternativa ao arrasto, principal no mobile).
import { Menu } from '@base-ui/react/menu'
import { ArrowRightLeft } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { useT } from '@/i18n'
import type { CardDto, ColumnDto, LabelOption } from './api'
import { formatBRL, formatPhone, unreadLabel } from './format'

const stop = (e: SyntheticEvent) => e.stopPropagation()

export function CardView({
  card,
  columns,
  labels,
  onMoveTo,
}: {
  card: CardDto
  columns: readonly ColumnDto[]
  labels: Record<string, LabelOption>
  onMoveTo: (columnId: string) => void
}) {
  const t = useT('crms')
  const phone = formatPhone(card.customer.phone_e164)
  const unread = unreadLabel(card.chat.unread_count)
  const chips = card.label_ids.map((id) => labels[id]).filter((l): l is LabelOption => !!l)
  const initial = (card.customer.name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          <span aria-hidden>{initial}</span>
          {unread ? (
            <span
              data-testid={`crms-card-unread-${card.id}`}
              aria-label={t('board.unread', { n: card.chat.unread_count })}
              className="absolute -top-1 -right-1 h-4 min-w-4 rounded-full bg-emerald-500 px-1 text-center text-[10px] leading-4 font-semibold text-white"
            >
              {unread}
            </span>
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <p data-testid={`crms-card-name-${card.id}`} className="truncate text-sm font-medium">
            {card.customer.name}
          </p>
          {phone ? (
            <p data-testid={`crms-card-phone-${card.id}`} className="truncate text-xs text-muted-foreground tabular-nums">
              {phone}
            </p>
          ) : null}
        </div>
        <Menu.Root>
          <Menu.Trigger
            data-testid={`crms-card-move-${card.id}`}
            aria-label={t('board.moveTo')}
            title={t('board.moveTo')}
            onClick={stop}
            className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowRightLeft className="size-3.5" aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end" className="z-50">
              <Menu.Popup
                data-testid={`crms-card-move-menu-${card.id}`}
                onClick={stop}
                className="min-w-48 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none"
              >
                <p className="px-2 py-1 text-xs text-muted-foreground">{t('board.moveTo')}</p>
                {columns.map((c) => (
                  <Menu.Item
                    key={c.id}
                    data-testid={`crms-card-move-option-${card.id}-${c.id}`}
                    disabled={c.id === card.column_id}
                    onClick={() => onMoveTo(c.id)}
                    className="flex cursor-default items-center rounded-md px-2 py-1.5 outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                  >
                    <span className="truncate">{c.name}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      {chips.length ? (
        <div data-testid={`crms-card-labels-${card.id}`} className="flex flex-wrap gap-1">
          {chips.map((l) => (
            <span
              key={l.id}
              data-testid={`crms-card-label-${card.id}-${l.id}`}
              className="max-w-full truncate rounded-full border px-2 py-0.5 text-[11px]"
              style={l.color ? { borderColor: l.color, color: l.color } : undefined}
            >
              {l.name}
            </span>
          ))}
        </div>
      ) : null}

      {card.chat.last_message_preview ? (
        <p data-testid={`crms-card-preview-${card.id}`} className="line-clamp-2 text-xs break-words text-muted-foreground">
          {card.chat.last_message_preview}
        </p>
      ) : null}

      {card.value_cents > 0 ? (
        <p data-testid={`crms-card-value-${card.id}`} className="text-sm font-semibold text-emerald-600 tabular-nums dark:text-emerald-400">
          {formatBRL(card.value_cents)}
        </p>
      ) : null}
    </div>
  )
}
