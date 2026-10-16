// Aba `/settings?tab=tags` (17 §3.E, AC-T58-04/05): etiquetas com cor e contagem de contatos; busca local (a API não
// pagina). Excluir remove a etiqueta dos contatos (o diálogo avisa quantos).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  ConfirmDialog,
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  SearchBox,
  serverMessage,
  TabHeader,
  usePerms,
} from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { LABELS_KEY, labelsApi, labelsQuery, type LabelDto } from './api'
import { COLOR_RE, filterLabels, labelIssue, NAME_MAX, normalizeColor, PRESET_COLORS, textOn } from './rules'

const NS = 'settings-labels'
const P = 'labels'

export default function LabelsTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.labels.edit'], ['settings.labels.delete'])
  const q = useQuery(labelsQuery())
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<LabelDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<LabelDto | null>(null)
  const rows = useMemo(() => filterLabels(q.data ?? [], search), [q.data, search])

  const nameCell = (r: LabelDto) => (
    <span
      data-testid={`${P}-item-name-${r.id}`}
      className="inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium break-all"
      style={{ backgroundColor: r.color, color: textOn(r.color) }}
    >
      {r.name}
    </span>
  )

  return (
    <section data-testid="page-labels" className="flex min-w-0 flex-col gap-4">
      <TabHeader
        prefix={P}
        title={t('title')}
        subtitle={t('subtitle')}
        canCreate={canEdit}
        newLabel={t('new')}
        onNew={() => setEditing('new')}
      />
      <SearchBox prefix={P} value={search} onChange={setSearch} placeholder={t('search')} />
      <DataList
        prefix={P}
        status={q.status}
        rows={rows}
        rowId={(r) => r.id}
        empty={search.trim() ? t('noResults') : t('empty')}
        title={nameCell}
        columns={[
          { id: 'name', header: t('cols.name'), cell: nameCell },
          {
            id: 'color',
            header: t('cols.color'),
            className: 'w-40',
            cell: (r) => (
              <span className="inline-flex items-center gap-2 font-mono text-xs">
                <span
                  data-testid={`${P}-item-color-${r.id}`}
                  data-color={r.color}
                  className="size-4 rounded-full border"
                  style={{ backgroundColor: r.color }}
                  aria-hidden
                />
                {r.color}
              </span>
            ),
          },
          {
            id: 'contacts',
            header: t('cols.contacts'),
            className: 'w-32',
            cell: (r) => (
              <span data-testid={`${P}-item-count-${r.id}`} className="tabular-nums">
                {r.contacts_count}
              </span>
            ),
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => canDelete}
        onEdit={(r) => setEditing(r)}
        onDelete={(r) => setDeleting(r)}
      />

      {editing ? (
        <LabelEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        prefix={P}
        open={!!deleting}
        title={t('deleteTitle')}
        body={deleting ? t('deleteBody', { name: deleting.name, n: deleting.contacts_count }) : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await labelsApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: LABELS_KEY })
          } catch (err) {
            notify('labels-error', serverMessage(err) ?? t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

function LabelEditor({ initial, onClose }: { initial: LabelDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [name, setName] = useState(initial?.name ?? '')
  const [color, setColor] = useState(initial?.color ?? PRESET_COLORS[5])
  const [tried, setTried] = useState(false)
  const issue = tried ? labelIssue(name, color) : null
  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), color: normalizeColor(color) }
      return initial ? labelsApi.update(initial.id, input) : labelsApi.create(input)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: LABELS_KEY })
      onClose()
    },
  })
  const nameError =
    issue === 'name' ? t('errors.name') : isFieldError(save.error, 'name') ? serverMessage(save.error, 'name') : null
  const colorError =
    issue === 'color'
      ? t('errors.color')
      : isFieldError(save.error, 'color')
        ? serverMessage(save.error, 'color')
        : null
  const valid = COLOR_RE.test(color)

  return (
    <FormDialog
      prefix={P}
      open
      title={initial ? t('editTitle') : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={
        save.error && !isFieldError(save.error, 'name') && !isFieldError(save.error, 'color')
          ? serverMessage(save.error)
          : null
      }
      onSubmit={() => {
        setTried(true)
        if (labelIssue(name, color)) return
        save.mutate()
      }}
    >
      <Field label={t('fields.name')} htmlFor="label-name" error={nameError} errorTestId={`${P}-name-error`}>
        <input
          id="label-name"
          data-testid={`${P}-name`}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => {
            setName(e.target.value)
            if (save.error) save.reset()
          }}
          className={inputClass}
          autoComplete="off"
        />
      </Field>
      <Field label={t('fields.color')} htmlFor="label-color-hex" error={colorError} errorTestId={`${P}-color-error`}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="color"
            data-testid={`${P}-color`}
            aria-label={t('fields.color')}
            value={valid ? color.toLowerCase() : '#000000'}
            onChange={(e) => setColor(e.target.value.toUpperCase())}
            className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1"
          />
          <input
            id="label-color-hex"
            data-testid={`${P}-color-hex`}
            value={color}
            maxLength={7}
            onChange={(e) => setColor(e.target.value)}
            onBlur={() => setColor((c) => normalizeColor(c))}
            className={cn(inputClass, 'w-28 font-mono uppercase')}
          />
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`${P}-preset-${c.slice(1)}`}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn(
                'size-7 rounded-full border-2',
                color.toUpperCase() === c ? 'border-foreground' : 'border-transparent',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </Field>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('fields.preview')}</span>
        <span
          data-testid={`${P}-preview`}
          className="rounded-full px-2.5 py-0.5 text-xs font-medium"
          style={{ backgroundColor: valid ? color : '#E5E7EB', color: textOn(valid ? color : '#E5E7EB') }}
        >
          {name.trim() || t('fields.name')}
        </span>
      </div>
    </FormDialog>
  )
}
