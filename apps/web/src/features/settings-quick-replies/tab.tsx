// Aba `/settings?tab=quick_replies` (17 §3.A, AC-T58-01/05): tabela com busca e paginação no servidor, editor com
// ações reordenáveis e mídia; atalho duplicado (409 `shortcut_taken`) mostra a mensagem do servidor no campo.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { ActionsEditor } from './actions-editor'
import { QR_KEY, quickRepliesApi, quickRepliesPageQuery, type QuickReplyDto } from './api'
import {
  ConfirmDialog,
  DataList,
  Field,
  FormDialog,
  isFieldError,
  Pager,
  SearchBox,
  serverMessage,
  TabHeader,
  useDebounced,
  usePerms,
} from './kit'
import { draftFromDto, draftIssue, normalizeShortcut, SHORTCUT_MAX, toInput, type DraftAction } from './rules'

const NS = 'settings-quick-replies'
const P = 'quick-replies'

export default function QuickRepliesTab() {
  const t = useT(NS)
  const qc = useQueryClient()
  const { canEdit, canDelete } = usePerms(['settings.quick_replies.edit'], ['settings.quick_replies.delete'])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const term = useDebounced(search.trim())
  const q = useQuery(quickRepliesPageQuery(page, term))
  const [editing, setEditing] = useState<QuickReplyDto | 'new' | null>(null)
  const [deleting, setDeleting] = useState<QuickReplyDto | null>(null)

  return (
    <section data-testid="page-quick-replies" className="flex min-w-0 flex-col gap-4">
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
        title={(r) => <span data-testid={`${P}-item-shortcut-${r.id}`}>/{r.shortcut}</span>}
        columns={[
          {
            id: 'shortcut',
            header: t('cols.shortcut'),
            className: 'w-48 font-medium',
            cell: (r) => <span data-testid={`${P}-item-shortcut-${r.id}`}>/{r.shortcut}</span>,
          },
          {
            id: 'preview',
            header: t('cols.preview'),
            cell: (r) => <span className="line-clamp-2 text-muted-foreground">{r.preview}</span>,
          },
          {
            id: 'actions',
            header: t('cols.actions'),
            className: 'w-28',
            cell: (r) => (
              <span data-testid={`${P}-item-count-${r.id}`} className="tabular-nums">
                {r.actions.length}
              </span>
            ),
          },
        ]}
        canEdit={() => canEdit}
        canDelete={() => canDelete}
        onEdit={(r) => setEditing(r)}
        onDelete={(r) => setDeleting(r)}
      />
      <Pager prefix={P} meta={q.data?.page} onPage={setPage} />

      {editing ? (
        <QuickReplyEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        prefix={P}
        open={!!deleting}
        title={t('deleteTitle')}
        body={deleting ? t('deleteBody', { shortcut: deleting.shortcut }) : ''}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return
          try {
            await quickRepliesApi.remove(deleting.id)
            await qc.invalidateQueries({ queryKey: QR_KEY })
          } catch (err) {
            notify('quick-replies-error', serverMessage(err) ?? t('common.error'))
          }
          setDeleting(null)
        }}
      />
    </section>
  )
}

function QuickReplyEditor({ initial, onClose }: { initial: QuickReplyDto | null; onClose: () => void }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '')
  const [actions, setActions] = useState<DraftAction[]>(() => (initial ? draftFromDto(initial.actions) : []))
  const [tried, setTried] = useState(false)
  const issue = tried ? draftIssue(shortcut, actions) : null
  const save = useMutation({
    mutationFn: () =>
      initial
        ? quickRepliesApi.update(initial.id, toInput(shortcut, actions))
        : quickRepliesApi.create(toInput(shortcut, actions)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: QR_KEY })
      onClose()
    },
  })
  const shortcutError = isFieldError(save.error, 'shortcut')
    ? serverMessage(save.error, 'shortcut')
    : issue === 'shortcut'
      ? t('errors.shortcut')
      : null
  const formError =
    save.error && !isFieldError(save.error, 'shortcut')
      ? serverMessage(save.error, 'actions')
      : issue === 'no_actions'
        ? t('errors.noActions')
        : issue && typeof issue === 'object'
          ? t('errors.actionIncomplete', { n: issue.index + 1 })
          : null

  return (
    <FormDialog
      prefix={P}
      open
      wide
      title={initial ? t('editTitle') : t('newTitle')}
      onClose={onClose}
      pending={save.isPending}
      error={formError}
      onSubmit={() => {
        setTried(true)
        if (draftIssue(shortcut, actions)) return
        save.mutate()
      }}
    >
      <Field
        label={t('fields.shortcut')}
        htmlFor="qr-shortcut"
        error={shortcutError}
        errorTestId={`${P}-shortcut-error`}
        hint={t('fields.shortcutHint')}
      >
        <div className="flex items-center rounded-md border focus-within:ring-2 focus-within:ring-ring">
          <span className="pl-3 text-sm text-muted-foreground">/</span>
          <input
            id="qr-shortcut"
            data-testid={`${P}-shortcut`}
            value={shortcut}
            maxLength={SHORTCUT_MAX}
            onChange={(e) => {
              setShortcut(e.target.value.toLowerCase().replace(/[^a-z0-9_ -]/g, ''))
              if (save.error) save.reset()
            }}
            onBlur={() => setShortcut((s) => normalizeShortcut(s))}
            className="h-9 w-full min-w-0 bg-transparent px-1 pr-3 text-sm outline-none"
            autoComplete="off"
          />
        </div>
      </Field>
      <ActionsEditor
        actions={actions}
        onChange={setActions}
        invalid={issue && typeof issue === 'object' ? issue : null}
      />
    </FormDialog>
  )
}
