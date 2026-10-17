// Navegação de pastas (06 §2.1): árvore (lateral no desktop, sheet no mobile), breadcrumb e "Voltar à pasta
// anterior". Cada nó da árvore e a raiz "Sem pasta" são alvos de soltura para fluxos e pastas.
import { ArrowLeft, ChevronRight, Folder, FolderOpen, Inbox } from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FolderDto } from './api'
import { dropKey, useDndState, useDropTarget } from './dnd'
import { breadcrumb, buildTree, type TreeNode } from './model'
import { folderColorClass } from './view'

export function FolderTree({
  folders,
  current,
  canDrag,
  onOpen,
}: {
  folders: readonly FolderDto[]
  current: string | null
  canDrag: boolean
  onOpen: (folderId: string | null) => void
}) {
  const t = useT('flows')
  const tree = useMemo(() => buildTree(folders), [folders])
  return (
    <nav data-testid="flows-tree" aria-label={t('tree.title')} className="flex flex-col gap-0.5 text-sm">
      <TreeItem
        testid="flows-folder-root"
        folderId={null}
        label={t('tree.root')}
        depth={0}
        active={current === null}
        canDrag={canDrag}
        onOpen={onOpen}
      />
      {tree.map((n) => (
        <Branch key={n.folder.id} node={n} current={current} canDrag={canDrag} onOpen={onOpen} />
      ))}
    </nav>
  )
}

function Branch({
  node,
  current,
  canDrag,
  onOpen,
}: {
  node: TreeNode
  current: string | null
  canDrag: boolean
  onOpen: (id: string | null) => void
}) {
  return (
    <>
      <TreeItem
        testid={`flows-folder-${node.folder.id}`}
        folderId={node.folder.id}
        label={node.folder.name}
        color={node.folder.color}
        depth={node.depth + 1}
        active={current === node.folder.id}
        canDrag={canDrag}
        onOpen={onOpen}
      />
      {node.children.map((c) => (
        <Branch key={c.folder.id} node={c} current={current} canDrag={canDrag} onOpen={onOpen} />
      ))}
    </>
  )
}

function TreeItem({
  testid,
  folderId,
  label,
  color,
  depth,
  active,
  canDrag,
  onOpen,
}: {
  testid: string
  folderId: string | null
  label: string
  color?: FolderDto['color']
  depth: number
  active: boolean
  canDrag: boolean
  onOpen: (id: string | null) => void
}) {
  const target = { kind: 'folder', folderId } as const
  const { ref, isOver } = useDropTarget(`tree:${folderId ?? 'root'}`, target, canDrag)
  const { blockedTarget } = useDndState()
  const blocked = isOver && blockedTarget === dropKey(target)
  const Icon = folderId === null ? Inbox : active ? FolderOpen : Folder
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testid}
      data-drop-target="folder"
      data-folder-id={folderId ?? 'root'}
      data-over={isOver ? (blocked ? 'blocked' : 'true') : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => onOpen(folderId)}
      style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-accent font-medium',
        isOver && !blocked && 'ring-2 ring-primary',
        blocked && 'cursor-not-allowed ring-2 ring-destructive',
      )}
    >
      {color ? <span className={cn('size-2 shrink-0 rounded-full', folderColorClass(color))} aria-hidden /> : null}
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function Breadcrumb({
  folders,
  current,
  onOpen,
}: {
  folders: readonly FolderDto[]
  current: string | null
  onOpen: (id: string | null) => void
}) {
  const t = useT('flows')
  const path = breadcrumb(folders, current)
  const parent = path.length > 1 ? path[path.length - 2]!.id : null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {current ? (
        <Button
          variant="ghost"
          size="sm"
          data-testid="flows-back"
          onClick={() => onOpen(parent)}
          aria-label={t('tree.back')}
          title={t('tree.back')}
        >
          <ArrowLeft aria-hidden />
          <span className="hidden sm:inline">{t('tree.back')}</span>
        </Button>
      ) : null}
      <nav data-testid="flows-breadcrumb" aria-label={t('tree.breadcrumb')} className="min-w-0 flex-1">
        <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <li>
            <button
              type="button"
              data-testid="flows-breadcrumb-root"
              onClick={() => onOpen(null)}
              className={cn('rounded px-1 hover:underline', !current && 'font-semibold')}
            >
              {t('tree.home')}
            </button>
          </li>
          {path.map((f, i) => (
            <li key={f.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                data-testid={`flows-breadcrumb-${f.id}`}
                aria-current={i === path.length - 1 ? 'page' : undefined}
                onClick={() => onOpen(f.id)}
                className={cn(
                  'min-w-0 truncate rounded px-1 hover:underline',
                  i === path.length - 1 && 'font-semibold',
                )}
              >
                {f.name}
              </button>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  )
}
