// Aba `/settings?tab=custom_fields` (17 §3.D, AC-T58-04/05): abas "Customizados" e "Sistema". Campo de sistema tem o
// valor calculado (somente leitura) e só a descrição editável; chave imutável e sem exclusão em ambos.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  SearchBox,
  serverMessage,
  TabHeader,
  textareaClass,
  usePerms,
} from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import { FIELDS_KEY, fieldsApi, fieldsQuery, type CustomFieldDto } from './api'
import { filterFields, KEY_MAX, keyIssue, normalizeKey, type FieldsView } from './rules'

const NS = 'settings-fields'
const P = 'fields'
const VIEWS: readonly FieldsView[] = ['custom', 'system']

export default function FieldsTab() {
  const t = useT(NS)
  const { canEdit } = usePerms(['settings.fields.edit'], [])
  const q = useQuery(fieldsQuery())
  const [view, setView] = useState<FieldsView>('custom')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<CustomFieldDto | 'new' | null>(null)
  const rows = useMemo(() => filterFields(q.data ?? [], view, search), [q.data, view, search])
  const systemKeys = useMemo(() => new Set((q.data ?? []).filter((f) => f.system).map((f) => f.key)), [q.data])

  const keyCell = (r: CustomFieldDto) => (
    <span data-testid={`${P}-item-key-${r.key}`} className="font-mono break-all">
      {`{${r.key}}`}
    </span>
  )

  return (
    <section data-testid="page-fields" className="flex min-w-0 flex-col gap-4">
      <TabHeader
        prefix={P}
        title={t('title')}
        subtitle={t('subtitle')}
        canCreate={canEdit && view === 'custom'}
        newLabel={t('new')}
        onNew={() => setEditing('new')}
      />
      <div role="tablist" aria-label={t('title')} className="flex gap-1 border-b">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            data-testid={`${P}-tab-${v}`}
            onClick={() => setView(v)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              view === v
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`views.${v}`)}
          </button>
        ))}
      </div>
      <SearchBox prefix={P} value={search} onChange={setSearch} placeholder={t('search')} />
      <DataList
        prefix={P}
        status={q.status}
        rows={rows}
        rowId={(r) => r.key}
        empty={search.trim() ? t('noResults') : view === 'custom' ? t('emptyCustom') : t('emptySystem')}
        title={keyCell}
        columns={[
          { id: 'key', header: t('cols.key'), className: 'w-64', cell: keyCell },
          {
            id: 'description',
            header: t('cols.description'),
            cell: (r) => <span data-testid={`${P}-item-description-${r.key}`}>{r.description ?? ''}</span>,
          },
          {
            id: 'value',
            header: view === 'system' ? t('cols.value') : t('cols.example'),
            cell: (r) =>
              r.system ? (
                <span
                  data-testid={`${P}-item-readonly-${r.key}`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                >
                  <Lock className="size-3" aria-hidden /> {t('readonlyValue')}
                </span>
              ) : (
                <span className="break-all text-muted-foreground">{r.example_value ?? ''}</span>
              ),
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => false}
        onEdit={(r) => setEditing(r)}
      />

      {editing ? (
        <FieldEditor
          key={editing === 'new' ? 'new' : editing.key}
          initial={editing === 'new' ? null : editing}
          systemKeys={systemKeys}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}

function FieldEditor({
  initial,
  systemKeys,
  onClose,
}: {
  initial: CustomFieldDto | null
  systemKeys: ReadonlySet<string>
  onClose: () => void
}) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [key, setKey] = useState(initial?.key ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tried, setTried] = useState(false)
  const issue = initial ? null : keyIssue(key, systemKeys)
  const save = useMutation({
    mutationFn: () =>
      initial
        ? fieldsApi.update(initial.key, description.trim() || null)
        : fieldsApi.create({ key: normalizeKey(key), description: description.trim() || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: FIELDS_KEY })
      onClose()
    },
  })
  const keyError =
    tried && issue ? t(`errors.${issue}`) : isFieldError(save.error, 'key') ? serverMessage(save.error, 'key') : null

  return (
    <FormDialog
      prefix={P}
      open
      title={initial ? (initial.system ? t('editSystemTitle') : t('editTitle')) : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={save.error && !isFieldError(save.error, 'key') ? serverMessage(save.error) : null}
      onSubmit={() => {
        setTried(true)
        if (issue) return
        save.mutate()
      }}
    >
      <Field
        label={t('fields.key')}
        htmlFor="field-key"
        error={keyError}
        errorTestId={`${P}-key-error`}
        hint={initial ? t('fields.keyImmutable') : t('fields.keyHint')}
      >
        <input
          id="field-key"
          data-testid={`${P}-key`}
          value={key}
          disabled={!!initial}
          maxLength={KEY_MAX}
          onChange={(e) => {
            setKey(e.target.value.toLowerCase())
            if (save.error) save.reset()
          }}
          className={cn(inputClass, 'font-mono')}
          autoComplete="off"
        />
      </Field>
      {initial?.system ? (
        <p
          data-testid={`${P}-system-note`}
          className="flex items-center gap-2 rounded-md bg-muted p-2 text-xs text-muted-foreground"
        >
          <Lock className="size-3.5 shrink-0" aria-hidden /> {t('systemNote')}
        </p>
      ) : null}
      <Field label={t('fields.description')} htmlFor="field-description">
        <textarea
          id="field-description"
          data-testid={`${P}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={cn(textareaClass, 'min-h-16')}
        />
      </Field>
    </FormDialog>
  )
}
