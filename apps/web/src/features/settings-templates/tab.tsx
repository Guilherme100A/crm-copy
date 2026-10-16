// Aba `/settings?tab=message_templates` (17 §3.B adaptado, AC-T58-02/05): modelos internos — sem status, categoria
// ou idioma de provedor. Editor com cabeçalho, corpo, rodapé, botões (viram texto) e prévia em balão de chat
// renderizada pelo servidor com as variáveis do contato de exemplo.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, Loader2, Plus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ConfirmDialog,
  DataList,
  Field,
  FormDialog,
  inputClass,
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
  BUTTON_TYPES,
  exampleContactsQuery,
  globalNamesQuery,
  HEADER_TYPES,
  previewQuery,
  TEMPLATES_KEY,
  templatesApi,
  templatesPageQuery,
  type ButtonType,
  type HeaderType,
  type TemplateDto,
  type TemplateInput,
} from './api'
import {
  CONTACT_VARIABLES,
  FOOTER_MAX,
  HEADER_TEXT_MAX,
  insertAt,
  MAX_BUTTONS,
  NAME_MAX,
  templateIssue,
  templateText,
  toTemplateInput,
} from './rules'

const NS = 'settings-templates'
const P = 'templates'

export default function TemplatesTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.message_templates.edit'], ['settings.message_templates.delete'])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim())
  const q = useQuery(templatesPageQuery(page, term))
  const [editing, setEditing] = useState<TemplateDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<TemplateDto | null>(null)

  return (
    <section data-testid="page-templates" className="flex min-w-0 flex-col gap-4">
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
        title={(r) => <span data-testid={`${P}-item-name-${r.id}`}>{r.name}</span>}
        columns={[
          {
            id: 'name',
            header: t('cols.name'),
            className: 'w-56 font-medium',
            cell: (r) => <span data-testid={`${P}-item-name-${r.id}`}>{r.name}</span>,
          },
          {
            id: 'body',
            header: t('cols.body'),
            cell: (r) => <span className="line-clamp-2 whitespace-pre-line text-muted-foreground">{r.body}</span>,
          },
          {
            id: 'buttons',
            header: t('cols.buttons'),
            className: 'w-24',
            cell: (r) => <span className="tabular-nums">{r.buttons.length}</span>,
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => canDelete}
        onEdit={(r) => setEditing(r)}
        onDelete={(r) => setDeleting(r)}
      />
      <Pager prefix={P} meta={q.data?.page} onPage={setPage} />

      {editing ? (
        <TemplateEditor
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
            await templatesApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: TEMPLATES_KEY })
          } catch (err) {
            notify('templates-error', serverMessage(err) ?? t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

const blank: TemplateInput = { name: '', header: { type: 'none' }, body: '', footer: '', buttons: [] }

function TemplateEditor({ initial, onClose }: { initial: TemplateDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [draft, setDraft] = useState<TemplateInput>(() =>
    initial
      ? {
          name: initial.name,
          header: { ...initial.header },
          body: initial.body,
          footer: initial.footer ?? '',
          buttons: initial.buttons.map((b) => ({ ...b })),
        }
      : blank,
  )
  const [tried, setTried] = useState(false)
  const [uploading, setUploading] = useState(false)
  const body = useRef<HTMLTextAreaElement>(null)
  const issue = tried ? templateIssue(draft) : null
  const set = (patch: Partial<TemplateInput>) => setDraft((d) => ({ ...d, ...patch }))
  const setButton = (i: number, patch: Partial<TemplateInput['buttons'][number]>) =>
    set({ buttons: draft.buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)) })
  const save = useMutation({
    mutationFn: () =>
      initial ? templatesApi.update(initial.id, toTemplateInput(draft)) : templatesApi.create(toTemplateInput(draft)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: TEMPLATES_KEY })
      onClose()
    },
  })
  const insertVar = (name: string) => {
    const el = body.current
    const { text, cursor } = insertAt(
      draft.body,
      `{${name}}`,
      el?.selectionStart ?? draft.body.length,
      el?.selectionEnd ?? draft.body.length,
    )
    set({ body: text })
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(cursor, cursor)
    })
  }
  const err = (k: string) => (issue === k ? t(`errors.${k}`) : null)
  const buttonBad = (i: number, f: string) =>
    !!issue && typeof issue === 'object' && issue.button === i && issue.field === f

  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={initial ? t('editTitle') : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={
        save.error
          ? serverMessage(save.error, 'name')
          : issue && typeof issue === 'object'
            ? t('errors.button', { n: issue.button + 1 })
            : null
      }
      onSubmit={() => {
        setTried(true)
        if (templateIssue(draft)) return
        save.mutate()
      }}
    >
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label={t('fields.name')} htmlFor="tpl-name" error={err('name')} errorTestId={`${P}-name-error`}>
            <input
              id="tpl-name"
              data-testid={`${P}-name`}
              value={draft.name}
              maxLength={NAME_MAX}
              onChange={(e) => set({ name: e.target.value })}
              className={inputClass}
              autoComplete="off"
            />
          </Field>

          <Field label={t('fields.header')} htmlFor="tpl-header-type" error={err('header_text') ?? err('header_media')}>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="tpl-header-type"
                data-testid={`${P}-header-type`}
                value={draft.header.type}
                onChange={(e) => set({ header: { type: e.target.value as HeaderType } })}
                className={cn(inputClass, 'w-auto')}
              >
                {HEADER_TYPES.map((h) => (
                  <option key={h} value={h}>
                    {t(`header.${h}`)}
                  </option>
                ))}
              </select>
              {draft.header.type === 'text' ? (
                <input
                  data-testid={`${P}-header-text`}
                  aria-label={t('fields.headerText')}
                  value={draft.header.text ?? ''}
                  maxLength={HEADER_TEXT_MAX}
                  onChange={(e) => set({ header: { type: 'text', text: e.target.value } })}
                  className={cn(inputClass, 'flex-1')}
                />
              ) : draft.header.type !== 'none' ? (
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent">
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <FileUp className="size-4" aria-hidden />
                  )}
                  {draft.header.media_id ? t('fields.mediaAttached') : t('fields.chooseFile')}
                  <input
                    data-testid={`${P}-header-file`}
                    type="file"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setUploading(true)
                      try {
                        const media = await templatesApi.upload(file)
                        set({ header: { type: draft.header.type, media_id: media.id } })
                      } catch (error) {
                        notify('templates-error', serverMessage(error) ?? t('common.error'))
                      } finally {
                        setUploading(false)
                      }
                    }}
                  />
                </label>
              ) : null}
            </div>
          </Field>

          <Field label={t('fields.body')} htmlFor="tpl-body" error={err('body')} errorTestId={`${P}-body-error`}>
            <textarea
              id="tpl-body"
              ref={body}
              data-testid={`${P}-body`}
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
              className={cn(textareaClass, 'min-h-32')}
            />
          </Field>
          <VariableChips onInsert={insertVar} />

          <Field label={t('fields.footer')} htmlFor="tpl-footer">
            <input
              id="tpl-footer"
              data-testid={`${P}-footer`}
              value={draft.footer ?? ''}
              maxLength={FOOTER_MAX}
              onChange={(e) => set({ footer: e.target.value })}
              className={inputClass}
            />
          </Field>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('fields.buttons')}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('buttonsCount', { n: draft.buttons.length, max: MAX_BUTTONS })}
              </span>
            </div>
            {draft.buttons.map((b, i) => (
              <div
                key={i}
                data-testid={`${P}-button-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
              >
                <select
                  data-testid={`${P}-button-type-${i}`}
                  aria-label={t('fields.buttonType')}
                  value={b.type}
                  onChange={(e) => setButton(i, { type: e.target.value as ButtonType })}
                  className={cn(inputClass, 'w-auto')}
                >
                  {BUTTON_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`buttons.${x}`)}
                    </option>
                  ))}
                </select>
                <input
                  data-testid={`${P}-button-text-${i}`}
                  aria-label={t('fields.buttonText')}
                  placeholder={t('fields.buttonText')}
                  value={b.text}
                  onChange={(e) => setButton(i, { text: e.target.value })}
                  className={cn(inputClass, 'min-w-32 flex-1', buttonBad(i, 'text') && 'border-destructive')}
                />
                {b.type === 'url' ? (
                  <input
                    data-testid={`${P}-button-url-${i}`}
                    aria-label={t('fields.buttonUrl')}
                    placeholder="https://"
                    value={b.url ?? ''}
                    onChange={(e) => setButton(i, { url: e.target.value })}
                    className={cn(inputClass, 'min-w-40 flex-1', buttonBad(i, 'url') && 'border-destructive')}
                  />
                ) : b.type === 'phone' ? (
                  <input
                    data-testid={`${P}-button-phone-${i}`}
                    aria-label={t('fields.buttonPhone')}
                    placeholder="+5511999999999"
                    inputMode="tel"
                    value={b.phone ?? ''}
                    onChange={(e) => setButton(i, { phone: e.target.value })}
                    className={cn(inputClass, 'min-w-40 flex-1', buttonBad(i, 'phone') && 'border-destructive')}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive"
                  data-testid={`${P}-button-remove-${i}`}
                  aria-label={t('fields.removeButton')}
                  onClick={() => set({ buttons: draft.buttons.filter((_, j) => j !== i) })}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-testid={`${P}-add-button`}
              disabled={draft.buttons.length >= MAX_BUTTONS}
              onClick={() => set({ buttons: [...draft.buttons, { type: 'reply', text: '' }] })}
            >
              <Plus aria-hidden /> {t('fields.addButton')}
            </Button>
          </div>
        </div>
        <Preview draft={draft} />
      </div>
    </FormDialog>
  )
}

function VariableChips({ onInsert }: { onInsert: (name: string) => void }) {
  const t = useT(NS)
  const globals = useQuery(globalNamesQuery()).data ?? []
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{t('variables')}</span>
      <div className="flex flex-wrap gap-1.5">
        {[...CONTACT_VARIABLES, ...globals].map((v) => (
          <button
            key={v}
            type="button"
            data-testid={`${P}-var-${v}`}
            onClick={() => onInsert(v)}
            className="rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-xs hover:bg-accent"
          >
            {`{${v}}`}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Balão de chat com o texto renderizado pelo servidor (variáveis do contato de exemplo e globais). */
function Preview({ draft }: { draft: TemplateInput }) {
  const t = useT(NS)
  const [contactSearch, setContactSearch] = useState('')
  const [contactId, setContactId] = useState<string | null>(null)
  const contacts = useQuery(exampleContactsQuery(useDebounced(contactSearch.trim())))
  const text = useDebounced(templateText(draft), 350)
  const preview = useQuery({ ...previewQuery(text, contactId), enabled: text.trim().length > 0 })
  const mediaType = draft.header.type !== 'none' && draft.header.type !== 'text' ? draft.header.type : null

  return (
    <aside className="flex min-w-0 flex-col gap-3">
      <span className="text-sm font-medium">{t('preview.title')}</span>
      <div className="flex flex-col gap-2">
        <input
          data-testid={`${P}-preview-contact-search`}
          type="search"
          value={contactSearch}
          onChange={(e) => setContactSearch(e.target.value)}
          placeholder={t('preview.searchContact')}
          aria-label={t('preview.searchContact')}
          className={inputClass}
        />
        <select
          data-testid={`${P}-preview-contact`}
          aria-label={t('preview.contact')}
          value={contactId ?? ''}
          onChange={(e) => setContactId(e.target.value || null)}
          className={inputClass}
        >
          <option value="">{t('preview.noContact')}</option>
          {(contacts.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone_e164 ? ` · ${c.phone_e164}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="rounded-xl bg-[#e5ddd5] p-3 dark:bg-zinc-800">
        <div
          data-testid={`${P}-preview`}
          className="ml-auto flex max-w-[95%] flex-col gap-1 rounded-lg rounded-tr-none bg-[#dcf8c6] p-2 text-sm text-zinc-900 shadow-sm dark:bg-emerald-900 dark:text-zinc-50"
        >
          {mediaType ? (
            <div
              data-testid={`${P}-preview-media`}
              className="flex h-24 items-center justify-center rounded-md bg-black/10 text-xs"
            >
              {t(`header.${mediaType}`)}
            </div>
          ) : null}
          <p data-testid={`${P}-preview-text`} className="break-words whitespace-pre-wrap">
            {!text.trim() ? <span className="text-zinc-500">{t('preview.empty')}</span> : (preview.data?.text ?? text)}
          </p>
          <span className="self-end text-[10px] text-zinc-500 dark:text-zinc-300">
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('preview.hint')}</p>
    </aside>
  )
}
