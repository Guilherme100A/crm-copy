// Menu da coluna (04 §2 "Coluna", §5.9–5.11): editar, alternar conversão e excluir (com confirmação).
import { Menu } from '@base-ui/react/menu'
import { MoreHorizontal, Pencil, Target, Trash2 } from 'lucide-react'
import type { ColumnDto } from '@/features/crms/api'
import { useT } from '@/i18n'

const itemClass = 'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent'

export function ColumnMenu({
  column,
  canEdit,
  canDelete,
  onEdit,
  onToggleConversion,
  onDelete,
}: {
  column: ColumnDto
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onToggleConversion: () => void
  onDelete: () => void
}) {
  const t = useT('kanban-tools')
  if (!canEdit && !canDelete) return null
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid={`crms-column-menu-${column.id}`}
        aria-label={t('column.menu', { name: column.name })}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className="min-w-52 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
            {canEdit ? (
              <>
                <Menu.Item data-testid={`crms-column-menu-edit-${column.id}`} onClick={onEdit} className={itemClass}>
                  <Pencil className="size-4" aria-hidden /> {t('column.edit')}
                </Menu.Item>
                <Menu.Item data-testid={`crms-column-menu-conversion-${column.id}`} onClick={onToggleConversion} className={itemClass}>
                  <Target className="size-4" aria-hidden /> {column.conversion_goal ? t('column.unmarkConversion') : t('column.markConversion')}
                </Menu.Item>
              </>
            ) : null}
            {canDelete ? (
              <Menu.Item data-testid={`crms-column-menu-delete-${column.id}`} onClick={onDelete} className={`${itemClass} text-destructive`}>
                <Trash2 className="size-4" aria-hidden /> {t('column.delete')}
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
