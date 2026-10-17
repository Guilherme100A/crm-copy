// `/flows` (06 §2.1, §5.1; T44): pastas e fluxos da pasta da URL (`?folder=`), busca, filtro de status, cartões ou
// tabela (paginada no cliente), árvore com breadcrumb, arrastar para mover/reordenar e as ações por fluxo. Sem
// `flows.edit` não há criar/importar/arrastar nem ações de edição; excluir pede `flows.delete`.
import { Dialog } from '@base-ui/react/dialog'
import { Menu } from '@base-ui/react/menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  FolderTree as FolderTreeIcon,
  GripVertical,
  LayoutGrid,
  MoreVertical,
  Plus,
  Table2,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { activationIssues } from '@/features/flow-editor/canvas/api'
import { SearchBox, serverMessage, useDebounced, usePerms } from '@/features/settings-quick-replies/kit'
import { useI18n, useT } from '@/i18n'
import { notify } from '@/lib/toast'
import { useIsDesktop } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import { applyReorder, flowsApi, flowsQuery, flowsQueryKey, type FlowDto, type FolderDto } from './api'
import {
  DeleteFlowDialog,
  DeleteFolderDialog,
  FolderDialog,
  ImportDialog,
  MoveDialog,
  RenameDialog,
  ShareDialog,
} from './dialogs'
import { dropKey, FlowsDnd, useDndState, useDragItem, useDropTarget, type DragData, type DropData } from './dnd'
import {
  breadcrumb,
  buildTree,
  canMoveFolder,
  folderCounts,
  folderIdOf,
  flowsIn,
  paginate,
  reorderPlan,
  statusActions,
  STATUS_FILTERS,
  uniqueName,
  updatedLabel,
  visibleItems,
  type StatusFilter,
  type TreeNode,
} from './model'
import { Breadcrumb, FolderTree } from './tree'
import { folderColorClass, StatusBadge, type FlowsSearch } from './view'

const NS = 'flows'

interface Perms {
  canEdit: boolean
  canDelete: boolean
}

export function FlowsPage({ search, onSearch }: { search: FlowsSearch; onSearch: (next: FlowsSearch) => void }) {
  const t = useT(NS)
  const desktop = useIsDesktop()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(flowsQuery())
  const perms = usePerms(['flows.edit'], ['flows.delete'])
  const current = folderIdOf(search.folder)
  const status: StatusFilter = search.flow_status ?? 'all'
  const view = desktop ? (search.view ?? 'cards') : 'cards'

  const [text, setText] = useState(search.q ?? '')
  const debounced = useDebounced(text, 300)
  useEffect(() => {
    if ((debounced.trim() || undefined) !== (search.q || undefined))
      onSearch({ ...search, q: debounced.trim() || undefined })
  }, [debounced]) // só o texto digitado dispara (a URL muda junto com `search`)

  const flows = useMemo(() => q.data?.items ?? [], [q.data])
  const folders = useMemo(() => q.data?.folders ?? [], [q.data])
  const shown = useMemo(
    () => visibleItems(flows, folders, { folder: current, search: search.q, status }),
    [flows, folders, current, search.q, status],
  )
  const filtering = !!search.q || status !== 'all'
  // Reordenar só faz sentido na pasta sem filtro (a posição é dentro da pasta).
  const canReorder = perms.canEdit && !filtering

  const [page, setPage] = useState(1)
  useEffect(() => setPage(1), [current, search.q, status])

  const [folderDialog, setFolderDialog] = useState<{ folder: FolderDto | null } | null>(null)
  const [folderToDelete, setFolderToDelete] = useState<FolderDto | null>(null)
  const [renaming, setRenaming] = useState<FlowDto | null>(null)
  const [moving, setMoving] = useState<FlowDto | null>(null)
  const [deleting, setDeleting] = useState<FlowDto | null>(null)
  const [sharing, setSharing] = useState<FlowDto | null>(null)
  const [importing, setImporting] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [creating, setCreating] = useState(false)

  const invalidate = () => qc.invalidateQueries({ queryKey: flowsQueryKey })
  const openFolder = (id: string | null) => {
    setTreeOpen(false)
    setText('')
    onSearch({ ...search, folder: id ?? undefined, q: undefined })
  }
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      notify('success', ok)
    } catch (err) {
      const issues = activationIssues(err)
      notify(
        'error',
        issues ? t('errors.activation', { n: issues.length }) : (serverMessage(err) ?? t('errors.generic')),
        issues?.[0]?.message,
      )
    } finally {
      await invalidate()
    }
  }

  const createFlow = async () => {
    setCreating(true)
    try {
      const taken = flowsIn(flows, current).map((f) => f.name)
      const flow = await flowsApi.create({ name: uniqueName(t('defaultName'), taken), folder_id: current })
      await invalidate()
      void navigate({ to: '/flows/$flowId/edit', params: { flowId: flow.id } })
    } catch (err) {
      notify('error', serverMessage(err) ?? t('errors.generic'))
    } finally {
      setCreating(false)
    }
  }

  // ------------------------------------------------------------ arrastar
  const canDrop = (source: DragData, target: DropData) =>
    source.kind === 'folder' && target.kind === 'folder' && target.folderId !== source.id
      ? canMoveFolder(folders, source.id, target.folderId)
      : true

  const onDrop = (source: DragData, target: DropData) => {
    setBlocked(false)
    if (source.kind === 'folder') {
      if (target.kind !== 'folder' || target.folderId === source.id) return
      const folder = folders.find((f) => f.id === source.id)
      if (!folder || (folder.parent_id ?? null) === target.folderId) return
      void run(() => flowsApi.moveFolder(source.id, target.folderId), t('dnd.folderMoved'))
      return
    }
    const flow = flows.find((f) => f.id === source.id)
    if (!flow) return
    if (target.kind === 'folder') {
      if ((flow.folder_id ?? null) === target.folderId) return
      void run(() => flowsApi.move(flow.id, target.folderId), t('dnd.flowMoved'))
      return
    }
    if (!canReorder) return
    const plan = reorderPlan(flowsIn(flows, current), flow.id, target.kind === 'flow' ? target.id : null)
    if (plan.length) void run(() => applyReorder(plan), t('dnd.reordered'))
  }

  const tree = <FolderTree folders={folders} current={current} canDrag={perms.canEdit} onOpen={openFolder} />
  const moveTargets = useMemo(() => flattenTree(buildTree(folders)), [folders])
  const currentMissing = !!current && q.isSuccess && !folders.some((f) => f.id === current)

  return (
    <section data-testid="page-flows" className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {perms.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" data-testid="flows-import" onClick={() => setImporting(true)}>
              <Download aria-hidden /> {t('actions.import')}
            </Button>
            <Button variant="outline" data-testid="flows-new-folder" onClick={() => setFolderDialog({ folder: null })}>
              <FolderPlus aria-hidden /> {t('actions.newFolder')}
            </Button>
            <Button data-testid="flows-new" disabled={creating} onClick={createFlow}>
              <Plus aria-hidden /> {t('actions.newFlow')}
            </Button>
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {!desktop ? (
          <Dialog.Root open={treeOpen} onOpenChange={setTreeOpen}>
            <Dialog.Trigger
              data-testid="flows-tree-open"
              className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-accent"
            >
              <FolderTreeIcon className="size-4" aria-hidden /> {t('tree.title')}
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-[60] bg-black/40" />
              <Dialog.Popup
                data-testid="flows-tree-sheet"
                className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[80dvh] flex-col rounded-t-2xl border-t bg-background shadow-xl outline-none"
              >
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <Dialog.Title className="text-sm font-semibold">{t('tree.title')}</Dialog.Title>
                  <Dialog.Close
                    data-testid="flows-tree-close"
                    aria-label={t('actions.close')}
                    className="rounded-md p-2 hover:bg-accent"
                  >
                    <X className="size-5" aria-hidden />
                  </Dialog.Close>
                </div>
                <div className="min-h-0 overflow-y-auto p-3">{tree}</div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        ) : null}
        <div className="min-w-0 flex-1 basis-56">
          <SearchBox prefix="flows" value={text} onChange={setText} placeholder={t('search')} />
        </div>
        <select
          data-testid="flows-status-filter"
          aria-label={t('filter.label')}
          value={status}
          onChange={(e) =>
            onSearch({
              ...search,
              flow_status: e.target.value === 'all' ? undefined : (e.target.value as StatusFilter),
            })
          }
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {t(`filter.${s}`)}
            </option>
          ))}
        </select>
        {filtering ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="flows-filters-clear"
            onClick={() => {
              setText('')
              onSearch({ ...search, q: undefined, flow_status: undefined })
            }}
          >
            {t('filter.clear')}
          </Button>
        ) : null}
        {desktop ? (
          <div role="group" aria-label={t('viewMode.label')} className="flex rounded-md border p-0.5">
            <ViewButton
              testid="flows-view-cards"
              active={view === 'cards'}
              label={t('viewMode.cards')}
              onClick={() => onSearch({ ...search, view: undefined })}
            >
              <LayoutGrid aria-hidden />
            </ViewButton>
            <ViewButton
              testid="flows-view-table"
              active={view === 'table'}
              label={t('viewMode.table')}
              onClick={() => onSearch({ ...search, view: 'table' })}
            >
              <Table2 aria-hidden />
            </ViewButton>
          </div>
        ) : null}
      </div>

      <FlowsDnd canDrop={canDrop} onDrop={onDrop} onBlocked={() => setBlocked(true)}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          {desktop ? (
            <aside className="min-w-0 rounded-xl border bg-card p-2 lg:sticky lg:top-4 lg:self-start">{tree}</aside>
          ) : null}
          <div className="flex min-w-0 flex-col gap-4">
            <Breadcrumb folders={folders} current={current} onOpen={openFolder} />
            {blocked ? (
              <div
                data-testid="flows-dnd-blocked"
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <span className="flex-1">{t('dnd.blocked')}</span>
                <button
                  type="button"
                  aria-label={t('actions.close')}
                  onClick={() => setBlocked(false)}
                  className="rounded p-1 hover:bg-destructive/10"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : null}
            {q.isPending ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-28 animate-pulse rounded-xl border bg-muted/40" />
                ))}
              </div>
            ) : q.isError ? (
              <div
                data-testid="flows-error"
                role="alert"
                className="flex items-center gap-3 rounded-lg border p-4 text-sm"
              >
                <span className="flex-1">{serverMessage(q.error) ?? t('errors.load')}</span>
                <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
                  {t('actions.retry')}
                </Button>
              </div>
            ) : currentMissing ? (
              <div
                data-testid="flows-folder-missing"
                className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
              >
                {t('tree.missing')}
              </div>
            ) : (
              <>
                {shown.folders.length ? (
                  <section aria-labelledby="flows-folders-title" className="flex flex-col gap-2">
                    <h2 id="flows-folders-title" className="text-sm font-semibold text-muted-foreground uppercase">
                      {t('sections.folders')}
                    </h2>
                    <ul data-testid="flows-folders" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {shown.folders.map((f) => (
                        <FolderCard
                          key={f.id}
                          folder={f}
                          counts={folderCounts(flows, folders, f.id)}
                          perms={perms}
                          onOpen={() => openFolder(f.id)}
                          onEdit={() => setFolderDialog({ folder: f })}
                          onDelete={() => setFolderToDelete(f)}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}
                {status !== 'folders' ? (
                  <section aria-labelledby="flows-list-title" className="flex min-w-0 flex-col gap-2">
                    <h2 id="flows-list-title" className="text-sm font-semibold text-muted-foreground uppercase">
                      {t('sections.flows')}
                    </h2>
                    {shown.flows.length === 0 ? (
                      <div
                        data-testid="flows-empty"
                        className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center"
                      >
                        <Workflow className="size-8 text-muted-foreground" aria-hidden />
                        <p className="text-sm text-muted-foreground">
                          {t(filtering ? 'empty.filtered' : 'empty.title')}
                        </p>
                        {perms.canEdit && !filtering ? (
                          <Button data-testid="flows-empty-create" disabled={creating} onClick={createFlow}>
                            <Plus aria-hidden /> {t('empty.create')}
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <FlowList
                        flows={shown.flows}
                        view={view}
                        page={page}
                        onPage={setPage}
                        perms={perms}
                        canReorder={canReorder}
                        folders={folders}
                        showFolder={!!search.q}
                        actions={{
                          rename: setRenaming,
                          move: setMoving,
                          remove: setDeleting,
                          share: setSharing,
                          duplicate: (f) => void run(() => flowsApi.duplicate(f.id), t('menu.duplicated')),
                          status: (f, a) => void run(() => flowsApi.setStatus(f.id, a), t(`menu.${a}Done`)),
                          removeFromFolder: (f) =>
                            void run(() => flowsApi.move(f.id, null), t('menu.removedFromFolder')),
                        }}
                      />
                    )}
                  </section>
                ) : null}
              </>
            )}
          </div>
        </div>
      </FlowsDnd>

      <FolderDialog
        open={!!folderDialog}
        folder={folderDialog?.folder ?? null}
        parentId={current}
        onClose={() => setFolderDialog(null)}
      />
      <DeleteFolderDialog
        folder={folderToDelete}
        onClose={() => {
          if (folderToDelete && breadcrumb(folders, current).some((f) => f.id === folderToDelete.id))
            openFolder(folderToDelete.parent_id)
          setFolderToDelete(null)
        }}
      />
      <RenameDialog flow={renaming} onClose={() => setRenaming(null)} />
      <MoveDialog flow={moving} folders={moveTargets} onClose={() => setMoving(null)} />
      <DeleteFlowDialog flow={deleting} onClose={() => setDeleting(null)} />
      <ShareDialog flow={sharing} onClose={() => setSharing(null)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </section>
  )
}

function flattenTree(nodes: readonly TreeNode[]): { id: string; label: string }[] {
  return nodes.flatMap((n) => [
    { id: n.folder.id, label: `${'— '.repeat(n.depth)}${n.folder.name}` },
    ...flattenTree(n.children),
  ])
}

function ViewButton({
  testid,
  active,
  label,
  onClick,
  children,
}: {
  testid: string
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-accent [&_svg]:size-4',
        active && 'bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- pastas

function FolderCard({
  folder,
  counts,
  perms,
  onOpen,
  onEdit,
  onDelete,
}: {
  folder: FolderDto
  counts: { flows: number; folders: number }
  perms: Perms
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useT(NS)
  const { ref, handleRef, isDragging, isOver } = useDragItem({ kind: 'folder', id: folder.id }, perms.canEdit)
  const { blockedTarget, active } = useDndState()
  const blocked =
    isOver && blockedTarget === dropKey({ kind: 'folder', folderId: folder.id }) && active?.id !== folder.id
  return (
    <li
      ref={ref}
      data-testid={`flows-folder-card-${folder.id}`}
      data-drop-target="folder"
      data-folder-id={folder.id}
      data-over={isOver ? (blocked ? 'blocked' : 'true') : undefined}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-xl border bg-card p-3',
        isDragging && 'opacity-60',
        isOver && !blocked && !isDragging && 'ring-2 ring-primary',
        blocked && 'ring-2 ring-destructive',
      )}
    >
      {perms.canEdit ? (
        <button
          ref={handleRef}
          type="button"
          data-testid={`flows-folder-handle-${folder.id}`}
          aria-label={t('dnd.dragFolder', { name: folder.name })}
          className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        data-testid={`flows-folder-open-${folder.id}`}
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg text-white',
            folderColorClass(folder.color),
          )}
        >
          <Folder className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span data-testid={`flows-folder-name-${folder.id}`} className="truncate font-medium">
            {folder.name}
          </span>
          <span
            data-testid={`flows-folder-count-${folder.id}`}
            data-flows={counts.flows}
            data-folders={counts.folders}
            className="text-xs text-muted-foreground"
          >
            {t('folder.counts', { flows: counts.flows, folders: counts.folders })}
          </span>
        </span>
      </button>
      {perms.canEdit || perms.canDelete ? (
        <ItemMenu testid={`flows-folder-menu-${folder.id}`} label={t('menu.more')}>
          {perms.canEdit ? (
            <MenuItem testid={`flows-folder-edit-${folder.id}`} label={t('folder.edit')} onClick={onEdit} />
          ) : null}
          {perms.canDelete ? (
            <MenuItem
              testid={`flows-folder-delete-${folder.id}`}
              label={t('folder.delete')}
              onClick={onDelete}
              destructive
            />
          ) : null}
        </ItemMenu>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------- fluxos

interface FlowActions {
  rename: (f: FlowDto) => void
  move: (f: FlowDto) => void
  remove: (f: FlowDto) => void
  share: (f: FlowDto) => void
  duplicate: (f: FlowDto) => void
  status: (f: FlowDto, action: 'activate' | 'pause' | 'archive' | 'unarchive') => void
  removeFromFolder: (f: FlowDto) => void
}

function FlowList({
  flows,
  view,
  page,
  onPage,
  perms,
  canReorder,
  folders,
  showFolder,
  actions,
}: {
  flows: FlowDto[]
  view: 'cards' | 'table'
  page: number
  onPage: (p: number) => void
  perms: Perms
  canReorder: boolean
  folders: readonly FolderDto[]
  showFolder: boolean
  actions: FlowActions
}) {
  const t = useT(NS)
  const { active } = useDndState()
  const folderName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? '') : t('tree.root'))
  const endZone = canReorder && active?.kind === 'flow' ? <EndZone /> : null

  if (view === 'cards')
    return (
      <>
        <ul data-testid="flows-cards" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {flows.map((f) => (
            <FlowItem
              key={f.id}
              flow={f}
              as="card"
              perms={perms}
              canReorder={canReorder}
              folder={showFolder ? folderName(f.folder_id) : null}
              actions={actions}
            />
          ))}
        </ul>
        {endZone}
      </>
    )

  const p = paginate(flows, page)
  return (
    <>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table data-testid="flows-table" className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('table.name')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('table.status')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('table.blocks')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('table.updated')}
              </th>
              <th scope="col" className="w-16 px-3 py-2">
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {p.rows.map((f) => (
              <FlowItem
                key={f.id}
                flow={f}
                as="row"
                perms={perms}
                canReorder={canReorder}
                folder={showFolder ? folderName(f.folder_id) : null}
                actions={actions}
              />
            ))}
          </tbody>
        </table>
      </div>
      {endZone}
      <nav
        data-testid="flows-pager"
        aria-label={t('table.pagination')}
        className="flex items-center justify-end gap-2 text-sm"
      >
        <span data-testid="flows-page-range" className="text-muted-foreground tabular-nums">
          {t('table.range', { from: p.from, to: p.to, total: p.total })}
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="flows-page-prev"
          disabled={p.page <= 1}
          onClick={() => onPage(p.page - 1)}
          aria-label={t('table.prev')}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="flows-page-next"
          disabled={p.page >= p.pages}
          onClick={() => onPage(p.page + 1)}
          aria-label={t('table.next')}
        >
          <ChevronRight aria-hidden />
        </Button>
      </nav>
    </>
  )
}

function EndZone() {
  const t = useT(NS)
  const { ref, isOver } = useDropTarget('flows-end', { kind: 'end' }, true)
  return (
    <div
      ref={ref}
      data-testid="flows-drop-end"
      data-drop-target="end"
      className={cn(
        'rounded-lg border-2 border-dashed p-3 text-center text-xs text-muted-foreground',
        isOver && 'border-primary text-primary',
      )}
    >
      {t('dnd.dropEnd')}
    </div>
  )
}

function FlowItem({
  flow,
  as,
  perms,
  canReorder,
  folder,
  actions,
}: {
  flow: FlowDto
  as: 'card' | 'row'
  perms: Perms
  canReorder: boolean
  folder: string | null
  actions: FlowActions
}) {
  const t = useT(NS)
  const { locale } = useI18n()
  const { ref, handleRef, isDragging, isOver } = useDragItem({ kind: 'flow', id: flow.id }, perms.canEdit)
  const { active } = useDndState()
  const reorderHint = isOver && canReorder && active?.kind === 'flow' && active.id !== flow.id
  const updated = updatedLabel(flow.updated_at, new Date(), locale)
  const updatedText = updated.kind === 'date' ? updated.text : t(`updated.${updated.kind}`, { time: updated.text })
  const link = perms.canEdit
    ? ({ to: '/flows/$flowId/edit', params: { flowId: flow.id } } as const)
    : ({ to: '/flows/$flowId', params: { flowId: flow.id } } as const)

  const handle = perms.canEdit ? (
    <button
      ref={handleRef}
      type="button"
      data-testid={`flows-item-handle-${flow.id}`}
      aria-label={t('dnd.dragFlow', { name: flow.name })}
      className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing"
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  ) : null
  const name = (
    <Link {...link} data-testid={`flows-item-name-${flow.id}`} className="min-w-0 truncate font-medium hover:underline">
      {flow.name}
    </Link>
  )
  const blocks = (
    <span data-testid={`flows-item-blocks-${flow.id}`} data-count={flow.nodes_count}>
      {t('blocks', { n: flow.nodes_count })}
    </span>
  )
  const menu = <FlowMenu flow={flow} perms={perms} link={link} actions={actions} />
  const hint = reorderHint ? (
    <span
      data-testid="flows-drop-hint"
      className="pointer-events-none absolute inset-x-2 -top-2.5 rounded bg-primary px-2 text-center text-[11px] text-primary-foreground"
    >
      {t('dnd.dropHere')}
    </span>
  ) : null
  const common = {
    ref,
    'data-testid': `flows-item-${flow.id}`,
    'data-folder-id': flow.folder_id ?? 'root',
    'data-position': flow.position,
    'data-over': reorderHint ? 'true' : undefined,
  }

  if (as === 'row')
    return (
      <tr
        {...common}
        className={cn(
          'relative align-middle hover:bg-muted/30',
          isDragging && 'opacity-60',
          reorderHint && 'border-t-2 border-t-primary',
        )}
      >
        <td className="px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {handle}
            <div className="flex min-w-0 flex-col">
              {name}
              {folder !== null ? <span className="truncate text-xs text-muted-foreground">{folder}</span> : null}
            </div>
            {hint}
          </div>
        </td>
        <td className="px-3 py-2">
          <StatusBadge id={flow.id} status={flow.status} />
        </td>
        <td className="px-3 py-2 tabular-nums">{blocks}</td>
        <td data-testid={`flows-item-updated-${flow.id}`} className="px-3 py-2 whitespace-nowrap text-muted-foreground">
          {updatedText}
        </td>
        <td className="px-3 py-1 text-right">{menu}</td>
      </tr>
    )

  return (
    <li
      {...common}
      className={cn(
        'relative flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3',
        isDragging && 'opacity-60',
        reorderHint && 'ring-2 ring-primary',
      )}
    >
      {hint}
      <div className="flex min-w-0 items-start gap-2">
        {handle}
        <div className="flex min-w-0 flex-1 flex-col">
          {name}
          {folder !== null ? <span className="truncate text-xs text-muted-foreground">{folder}</span> : null}
        </div>
        {menu}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge id={flow.id} status={flow.status} />
        {blocks}
        <span aria-hidden>·</span>
        <span data-testid={`flows-item-updated-${flow.id}`}>{updatedText}</span>
      </div>
    </li>
  )
}

function FlowMenu({
  flow,
  perms,
  link,
  actions,
}: {
  flow: FlowDto
  perms: Perms
  link: { to: '/flows/$flowId/edit' | '/flows/$flowId'; params: { flowId: string } }
  actions: FlowActions
}) {
  const t = useT(NS)
  const navigate = useNavigate()
  const id = flow.id
  return (
    <ItemMenu testid={`flows-item-menu-${id}`} label={t('menu.more')}>
      {perms.canEdit ? (
        <>
          <MenuItem testid={`flows-item-edit-${id}`} label={t('menu.edit')} onClick={() => void navigate(link)} />
          <MenuItem testid={`flows-item-rename-${id}`} label={t('menu.rename')} onClick={() => actions.rename(flow)} />
          <MenuItem
            testid={`flows-item-duplicate-${id}`}
            label={t('menu.duplicate')}
            onClick={() => actions.duplicate(flow)}
          />
        </>
      ) : (
        <MenuItem testid={`flows-item-open-${id}`} label={t('menu.open')} onClick={() => void navigate(link)} />
      )}
      <MenuItem testid={`flows-item-share-${id}`} label={t('menu.share')} onClick={() => actions.share(flow)} />
      {perms.canEdit ? (
        <>
          {statusActions(flow.status).map((a) => (
            <MenuItem
              key={a}
              testid={`flows-item-${a}-${id}`}
              label={t(`menu.${a}`)}
              onClick={() => actions.status(flow, a)}
            />
          ))}
          <MenuItem testid={`flows-item-move-${id}`} label={t('menu.move')} onClick={() => actions.move(flow)} />
          {flow.folder_id ? (
            <MenuItem
              testid={`flows-item-remove-folder-${id}`}
              label={t('menu.removeFromFolder')}
              onClick={() => actions.removeFromFolder(flow)}
            />
          ) : null}
        </>
      ) : null}
      {perms.canDelete ? (
        <MenuItem
          testid={`flows-item-delete-${id}`}
          label={t('menu.delete')}
          onClick={() => actions.remove(flow)}
          destructive
        />
      ) : null}
    </ItemMenu>
  )
}

function ItemMenu({ testid, label, children }: { testid: string; label: string; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid={testid}
        aria-label={label}
        title={label}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MoreVertical className="size-4" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className="min-w-48 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
            {children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function MenuItem({
  testid,
  label,
  onClick,
  destructive,
}: {
  testid: string
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <Menu.Item
      data-testid={testid}
      onClick={onClick}
      className={cn(
        'flex cursor-default items-center rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-accent',
        destructive && 'text-destructive',
      )}
    >
      {label}
    </Menu.Item>
  )
}
