// Aba `/settings?tab=global_variables` (17 §3.C, AC-T58-03/05): o prefixo `g_` aparece fixo antes do nome (que fica
// imutável na edição) e o tipo número recusa texto no cliente, antes de ir ao servidor.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ConfirmDialog,
  DataList,
  Field,
  FormDialog,
  inputClass,
  isFieldError,
  Pager,
  SearchBox,
  serverMessage,
  TabHeader,
  textareaClass,
  useDebounced,
  usePerms,
} from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  VARIABLE_TYPES,
  VARIABLES_KEY,
  variablesApi,
  variablesPageQuery,
  type GlobalVariableDto,
  type VariableType,
} from './api'
import { NAME_MAX, nameIssue, nameSuffix, PREFIX, stripPrefix, valueIssue } from './rules'

const NS = 'settings-variables'
const P = 'variables'

export default function VariablesTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.global_variables.edit'], ['settings.global_variables.delete'])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim())
  const q = useQuery(variablesPageQuery(page, term))
  const [editing, setEditing] = useState<GlobalVariableDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<GlobalVariableDto | null>(null)

  const nameCell = (r: GlobalVariableDto) => (
    <span data-testid={`${P}-item-name-${r.id}`} className="font-mono">
      <span className="text-muted-foreground">{PREFIX}</span>
      {stripPrefix(r.name)}
    </span>
  )

  return (
    <section data-testid="page-variables" className="flex min-w-0 flex-col gap-4">
      <TabHeader
        prefix={P}
        title={t('title')}
        subtitle={t('subtitle')}
        canCreate={canEdit}
        newLabel={t('new')}
        onNew={() => setEditing('new')}
      />
      <SearchBox
        prefix={P}
        value={search}
        placeholder={t('search')}
        onChange={(v) => {
          setSearch(v)
          setPage(1)
        }}
      />
      <DataList
        prefix={P}
        status={q.status}
        rows={q.data?.items ?? []}
        rowId={(r) => r.id}
        empty={term ? t('noResults') : t('empty')}
        title={nameCell}
        columns={[
          { id: 'name', header: t('cols.name'), className: 'w-56', cell: nameCell },
          {
            id: 'type',
            header: t('cols.type'),
            className: 'w-28',
            cell: (r) => <span data-testid={`${P}-item-type-${r.id}`}>{t(`types.${r.type}`)}</span>,
          },
          {
            id: 'value',
            header: t('cols.value'),
            cell: (r) => (
              <span data-testid={`${P}-item-value-${r.id}`} className="break-all">
                {r.value ?? ''}
              </span>
            ),
          },
          {
            id: 'description',
            header: t('cols.description'),
            cell: (r) => <span className="text-muted-foreground">{r.description ?? ''}</span>,
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => canDelete}
        onEdit={(r) => setEditing(r)}
        onDelete={(r) => setDeleting(r)}
      />
      <Pager prefix={P} meta={q.data?.page} onPage={setPage} />

      {editing ? (
        <VariableEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        prefix={P}
        open={!!deleting}
        title={t('deleteTitle')}
        body={deleting ? t('deleteBody', { name: deleting.name }) : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await variablesApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: VARIABLES_KEY })
          } catch (err) {
            notify('variables-error', serverMessage(err) ?? t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

function VariableEditor({ initial, onClose }: { initial: GlobalVariableDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [suffix, setSuffix] = useState(initial ? stripPrefix(initial.name) : '')
  const [type, setType] = useState<VariableType>(initial?.type ?? 'text')
  const [value, setValue] = useState(initial?.value ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [tried, setTried] = useState(false)
  // O número é checado enquanto digita (AC-T58-03); o nome só depois da primeira tentativa de salvar.
  const vIssue = valueIssue(type, value)
  const nIssue = initial ? null : nameIssue(suffix)
  const save = useMutation({
    mutationFn: () =>
      initial
        ? variablesApi.update(initial.id, { type, value: value.trim(), description: description.trim() || null })
        : variablesApi.create({
            name: `${PREFIX}${suffix}`,
            type,
            value: value.trim(),
            description: description.trim() || null,
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: VARIABLES_KEY })
      onClose()
    },
  })
  const nameError =
    tried && nIssue
      ? t(`errors.${nIssue}`)
      : isFieldError(save.error, 'name')
        ? serverMessage(save.error, 'name')
        : null
  const valueError = vIssue
    ? t('errors.number')
    : isFieldError(save.error, 'value')
      ? serverMessage(save.error, 'value')
      : null

  return (
    <FormDialog
      prefix={P}
      open
      title={initial ? t('editTitle') : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={
        save.error && !isFieldError(save.error, 'name') && !isFieldError(save.error, 'value')
          ? serverMessage(save.error)
          : null
      }
      onSubmit={() => {
        setTried(true)
        if (nIssue || vIssue) return
        save.mutate()
      }}
    >
      <Field
        label={t('fields.name')}
        htmlFor="var-name"
        error={nameError}
        errorTestId={`${P}-name-error`}
        hint={initial ? t('fields.nameImmutable') : t('fields.nameHint')}
      >
        <div
          className={cn(
            'flex items-center rounded-md border focus-within:ring-2 focus-within:ring-ring',
            initial && 'opacity-60',
          )}
        >
          <span
            data-testid={`${P}-prefix`}
            className="border-r bg-muted px-3 py-2 font-mono text-sm text-muted-foreground select-none"
          >
            {PREFIX}
          </span>
          <input
            id="var-name"
            data-testid={`${P}-name`}
            value={suffix}
            disabled={!!initial}
            maxLength={NAME_MAX - PREFIX.length}
            onChange={(e) => setSuffix(nameSuffix(e.target.value))}
            className="h-9 w-full min-w-0 bg-transparent px-3 font-mono text-sm outline-none"
            autoComplete="off"
          />
        </div>
      </Field>
      <Field label={t('fields.type')} htmlFor="var-type">
        <select
          id="var-type"
          data-testid={`${P}-type`}
          value={type}
          onChange={(e) => setType(e.target.value as VariableType)}
          className={inputClass}
        >
          {VARIABLE_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`types.${x}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t('fields.value')}
        htmlFor="var-value"
        error={valueError}
        errorTestId={`${P}-value-error`}
        hint={type === 'number' ? t('fields.numberHint') : undefined}
      >
        <input
          id="var-value"
          data-testid={`${P}-value`}
          value={value}
          inputMode={type === 'number' ? 'decimal' : undefined}
          aria-invalid={!!vIssue}
          onChange={(e) => setValue(e.target.value)}
          className={cn(inputClass, vIssue && 'border-destructive')}
        />
      </Field>
      <Field label={t('fields.description')} htmlFor="var-description">
        <textarea
          id="var-description"
          data-testid={`${P}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={cn(textareaClass, 'min-h-16')}
        />
      </Field>
    </FormDialog>
  )
}
