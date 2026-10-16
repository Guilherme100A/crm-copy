// Departamentos (16 §3.2, §5): lista paginada (20) com busca no servidor, criar/editar com a paleta de 10 cores ou
// cor própria e excluir com diálogo de confirmação. Permissões `settings.departments.view|edit|delete`.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fieldMessage } from '@/features/auth/api'
import { can, ConfirmDialog, inputClass, LoadError, Loading, useSession } from '@/features/settings-company/ui'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { DEPARTMENTS_KEY, departmentsApi, departmentsQuery, type DepartmentDto } from './api'
import {
  DEFAULT_DEPARTMENT_COLOR,
  DEPARTMENT_NAME_MAX,
  DEPARTMENT_PALETTE,
  departmentFormErrors,
  normalizeHex,
  paletteId,
} from './palette'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

export default function DepartmentsPanel() {
  const t = useT('settings-departments')
  const qc = useQueryClient()
  const session = useSession()
  const canEdit = can(session, 'settings.departments.edit')
  const canDelete = can(session, 'settings.departments.delete')
  const [search, setSearch] = useState('')
  const term = useDebounced(search.trim(), 300)
  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [term])
  const q = useQuery(departmentsQuery(page, term))
  const [editing, setEditing] = useState<DepartmentDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<DepartmentDto | null>(null)
  const items = q.data?.items ?? []
  const info = q.data?.page

  return (
    <div data-testid="departments-panel" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canEdit ? (
          <Button data-testid="departments-new" onClick={() => setEditing('new')}>
            <Plus aria-hidden /> {t('new')}
          </Button>
        ) : null}
      </div>
      <label className="relative block w-full sm:max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          data-testid="departments-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search')}
          aria-label={t('search')}
          className={cn(inputClass, 'pl-9')}
        />
      </label>

      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError testId="departments-error" onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <div
          data-testid="departments-empty"
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
        >
          <p>{term ? t('noResults') : t('empty')}</p>
          {!term && canEdit ? (
            <Button variant="outline" data-testid="departments-empty-create" onClick={() => setEditing('new')}>
              <Plus aria-hidden /> {t('createFirst')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul
          data-testid="departments-list"
          className={cn('flex flex-col divide-y rounded-xl border bg-card', q.isPlaceholderData && 'opacity-60')}
        >
          {items.map((d) => (
            <li key={d.id} data-testid={`departments-item-${d.id}`} className="flex items-center gap-3 p-3">
              <span
                data-testid={`departments-item-color-${d.id}`}
                data-color={d.color}
                className="size-4 shrink-0 rounded-full border"
                style={{ backgroundColor: d.color }}
                aria-hidden
              />
              <span data-testid={`departments-item-name-${d.id}`} className="min-w-0 flex-1 truncate font-medium">
                {d.name}
              </span>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  data-testid={`departments-item-edit-${d.id}`}
                  aria-label={t('edit')}
                  onClick={() => setEditing(d)}
                >
                  <Pencil aria-hidden />
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive"
                  data-testid={`departments-item-delete-${d.id}`}
                  aria-label={t('delete')}
                  onClick={() => setDeleting(d)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {info && (info.page > 1 || info.has_more) ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            data-testid="departments-prev"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label={t('prev')}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span data-testid="departments-page">
            {info.total_pages ? t('pageOf', { page: info.page, total: info.total_pages }) : info.page}
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid="departments-next"
            disabled={!info.has_more}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t('next')}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : null}

      {editing ? (
        <DepartmentForm department={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        testId="departments-confirm"
        title={t('deleteTitle')}
        body={deleting ? t('deleteBody', { name: deleting.name }) : ''}
        confirmLabel={t('delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await departmentsApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: DEPARTMENTS_KEY })
            notify('departments-deleted', t('deleted'))
            setDeleting(null)
          } catch {
            notify('departments-error', t('saveError'))
          }
        }}
      />
    </div>
  )
}

function DepartmentForm({ department, onClose }: { department: DepartmentDto | null; onClose: () => void }) {
  const t = useT('settings-departments')
  const qc = useQueryClient()
  const [name, setName] = useState(department?.name ?? '')
  const [color, setColor] = useState(department?.color ?? DEFAULT_DEPARTMENT_COLOR)
  const [customText, setCustomText] = useState(department && !paletteId(department.color) ? department.color : '')
  const [serverError, setServerError] = useState<{ name?: string; color?: string }>({})
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)
  const errors = departmentFormErrors(name, color)
  const selected = paletteId(color)
  const nameError =
    serverError.name ??
    (touched && errors.includes('nameRequired')
      ? t('nameRequired')
      : errors.includes('nameTooLong')
        ? t('nameTooLong', { max: DEPARTMENT_NAME_MAX })
        : null)
  const colorError = serverError.color ?? (errors.includes('colorInvalid') ? t('colorInvalid') : null)

  async function save() {
    setTouched(true)
    if (errors.length) return
    setSaving(true)
    const input = { name: name.trim(), color: normalizeHex(color)! }
    try {
      if (department) await departmentsApi.update(department.id, input)
      else await departmentsApi.create(input)
      await qc.invalidateQueries({ queryKey: DEPARTMENTS_KEY })
      notify('departments-saved', t('saved'))
      onClose()
    } catch (err) {
      setServerError({ name: fieldMessage(err, 'name') ?? undefined, color: fieldMessage(err, 'color') ?? undefined })
      notify('departments-error', t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="departments-form"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{department ? t('editTitle') : t('newTitle')}</Dialog.Title>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="departments-form-name" className="text-sm font-medium">
                {t('name')} <span className="text-destructive">*</span>
              </label>
              <input
                id="departments-form-name"
                data-testid="departments-form-name"
                className={inputClass}
                value={name}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value)
                  setServerError((s) => ({ ...s, name: undefined }))
                }}
                onBlur={() => setTouched(true)}
              />
              {nameError ? (
                <p data-testid="departments-form-name-error" className="text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('color')}</legend>
              <div role="radiogroup" aria-label={t('color')} className="grid grid-cols-5 gap-2">
                {DEPARTMENT_PALETTE.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={selected === p.id}
                    aria-label={t(`colors.${p.id}`)}
                    title={t(`colors.${p.id}`)}
                    data-testid={`departments-color-${p.id}`}
                    data-color={p.hex}
                    onClick={() => {
                      setColor(p.hex)
                      setCustomText('')
                      setServerError((s) => ({ ...s, color: undefined }))
                    }}
                    className={cn(
                      'flex h-9 items-center justify-center rounded-md border-2',
                      selected === p.id ? 'border-foreground' : 'border-transparent',
                    )}
                    style={{ backgroundColor: p.hex }}
                  >
                    {selected === p.id ? <Check className="size-4 text-white" aria-hidden /> : null}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  data-testid="departments-color-picker"
                  aria-label={t('customColor')}
                  value={normalizeHex(color) ?? DEFAULT_DEPARTMENT_COLOR}
                  onChange={(e) => {
                    const hex = normalizeHex(e.target.value) ?? e.target.value
                    setColor(hex)
                    setCustomText(hex)
                  }}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                />
                <input
                  data-testid="departments-color-custom"
                  className={inputClass}
                  placeholder={t('customPlaceholder')}
                  aria-label={t('customColor')}
                  value={customText}
                  maxLength={7}
                  onChange={(e) => {
                    setCustomText(e.target.value)
                    setColor(e.target.value || DEFAULT_DEPARTMENT_COLOR)
                    setServerError((s) => ({ ...s, color: undefined }))
                  }}
                />
              </div>
              <p data-testid="departments-color-kind" className="text-xs text-muted-foreground">
                {selected
                  ? t(`colors.${selected}`)
                  : colorError
                    ? null
                    : t('customLabel', { color: normalizeHex(color) ?? color })}
              </p>
              {colorError ? (
                <p data-testid="departments-form-color-error" className="text-xs text-destructive">
                  {colorError}
                </p>
              ) : null}
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button variant="outline" data-testid="departments-form-cancel" disabled={saving} onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button type="submit" data-testid="departments-form-save" disabled={saving || errors.length > 0}>
                {t('save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
