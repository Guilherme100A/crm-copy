// Editor de fluxos (T45; 06 §2.2, §5.2–5.4): canvas @xyflow/react controlado (zoom 0,02–2, minimapa, controles), paleta,
// painel de propriedades, autosave do rascunho inteiro ("Salvo às HH:MM"), copiar/colar (Ctrl+C/V), excluir com
// confirmação, ativar/pausar com os erros por nó e atualização em tempo real quando outra pessoa muda o grafo.
import '@xyflow/react/dist/style.css'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useEdgesState,
  useReactFlow,
  type Connection,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react'
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Pause, Pencil, Play, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { FLOW_NODE_TYPE_VALUES, type FlowAction, type NodeType } from '@crm/shared/flows'
import { Button } from '@/components/ui/button'
import { useI18n, useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { DND_MIME } from '../palette/catalog'
import { Palette } from '../palette/palette'
import { PropertiesPanel } from '../properties/properties-panel'
import { bundleKey, bundleQuery, flowApi, type EditorBundle, type FlowDto, type FlowStatus } from './api'
import { Autosaver, type AutosaveStatus } from './autosave'
import { FlowNodeComponent, NodeActionsContext, type NodeActions } from './flow-node'
import {
  CLIPBOARD_KEY,
  PASTE_OFFSET,
  connect,
  copySelection,
  errorsByNode,
  metaOf,
  newId,
  parseClipboard,
  paste,
  removeNodes,
  toDefinition,
  toGraph,
  withErrors,
  type ClipboardPayload,
  type EditorEdge,
  type EditorNode,
  type ValidationIssue,
} from './model'
import { isForeign, onGraphUpdated } from './realtime'

/** Um componente para todos os tipos (fora do componente: o xyflow remonta os nós se o objeto mudar). */
const NODE_TYPES: NodeTypes = Object.fromEntries(FLOW_NODE_TYPE_VALUES.map((t) => [t, FlowNodeComponent]))

/** Largura do nó (centralizar ao adicionar pelo clique). */
const NODE_WIDTH = 224

let memoryClipboard: ClipboardPayload | null = null

function readClipboard(): ClipboardPayload | null {
  try {
    return parseClipboard(globalThis.localStorage?.getItem(CLIPBOARD_KEY) ?? null) ?? memoryClipboard
  } catch {
    return memoryClipboard
  }
}

function writeClipboard(clip: ClipboardPayload) {
  memoryClipboard = clip
  try {
    globalThis.localStorage?.setItem(CLIPBOARD_KEY, JSON.stringify(clip))
  } catch {
    // sem storage: vale só nesta aba
  }
}

export function FlowEditorPage({ flowId, mode }: { flowId: string; mode: 'edit' | 'view' }) {
  const t = useT('flow-editor')
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const q = useQuery(bundleQuery(flowId))
  const canEdit = mode === 'edit' && !!session && hasAny(session, ['flows.edit'])

  if (q.isPending || !session)
    return (
      <p data-testid="flow-editor-loading" className="text-sm text-muted-foreground">
        {t('editor.loading')}
      </p>
    )
  if (q.isError)
    return (
      <div data-testid="flow-editor-error" className="flex items-center gap-3 rounded-lg border p-4 text-sm">
        <span className="flex-1">{t('editor.loadError')}</span>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  return (
    <ReactFlowProvider>
      <EditorBody key={flowId} bundle={q.data} readOnly={!canEdit} canEditFlows={hasAny(session, ['flows.edit'])} me={session.user.id} mode={mode} />
    </ReactFlowProvider>
  )
}

interface DeleteRequest {
  nodeIds: string[]
  edgeIds: string[]
}

function EditorBody({ bundle, readOnly, canEditFlows, me, mode }: { bundle: EditorBundle; readOnly: boolean; canEditFlows: boolean; me: string; mode: 'edit' | 'view' }) {
  const t = useT('flow-editor')
  const { locale } = useI18n()
  const qc = useQueryClient()
  const rf = useReactFlow<EditorNode, EditorEdge>()
  const flowId = bundle.flow.id
  const initial = useMemo(() => toGraph(bundle.definition), [bundle.definition])
  const [nodes, setNodes] = useState<EditorNode[]>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(initial.edges)
  const [flow, setFlow] = useState<FlowDto>(bundle.flow)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [status, setStatus] = useState<AutosaveStatus>({ state: 'idle', savedAt: null })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [propsOpen, setPropsOpen] = useState(false)
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)
  const [busy, setBusy] = useState(false)

  const meta = useRef(metaOf(bundle.definition))
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges
  const wrapper = useRef<HTMLDivElement>(null)
  const pasteCount = useRef(0)

  const saver = useMemo(
    () =>
      new Autosaver(async () => {
        await flowApi.save(flowId, toDefinition({ nodes: nodesRef.current, edges: edgesRef.current }, meta.current))
      }, setStatus),
    [flowId],
  )
  useEffect(
    () => () => {
      // Saindo do editor com mudança pendente: salva o que falta.
      if (saver.pending) void saver.flush().catch(() => undefined)
      saver.dispose()
    },
    [saver],
  )

  const dirty = useCallback(() => {
    if (!readOnly) saver.schedule()
  }, [readOnly, saver])

  const onNodesChange = useCallback(
    (changes: NodeChange<EditorNode>[]) => {
      // Sem permissão só seleção/medidas; exclusão passa pela confirmação (deleteKeyCode desligado).
      const allowed = changes.filter((c) => c.type !== 'remove' && (!readOnly || c.type === 'select' || c.type === 'dimensions'))
      if (allowed.length) setNodes((ns) => applyNodeChanges(allowed, ns))
    },
    [readOnly],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly) return
      setEdges((es) => connect(es, c, meta.current.entry) ?? es)
      dirty()
    },
    [dirty, readOnly, setEdges],
  )

  const addNode = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      if (readOnly) return
      const id = newId('n')
      const node: EditorNode = {
        id,
        type,
        position: { x: Math.round(position.x), y: Math.round(position.y) },
        selected: true,
        data: { name: t(`types.${type}`), actions: [] },
      }
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), node])
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)))
      dirty()
    },
    [dirty, readOnly, setEdges, t],
  )

  const addAtCenter = useCallback(
    (type: NodeType) => {
      const box = wrapper.current?.getBoundingClientRect()
      const center = box ? rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 }
      addNode(type, { x: center.x - NODE_WIDTH / 2, y: center.y - 40 })
      if (window.matchMedia?.('(max-width: 1023px)').matches) setPaletteOpen(false)
    },
    [addNode, rf],
  )

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(DND_MIME)
      if (!type) return
      e.preventDefault()
      addNode(type as NodeType, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    },
    [addNode, rf],
  )

  const selectedIds = useMemo(() => new Set(nodes.filter((n) => n.selected).map((n) => n.id)), [nodes])
  const selectedEdge = edges.find((e) => e.selected) ?? null
  const selectedNode = nodes.length && selectedIds.size === 1 ? (nodes.find((n) => n.selected) ?? null) : null

  const doPaste = useCallback(
    (clip: ClipboardPayload, offset: number) => {
      const r = paste({ nodes: nodesRef.current, edges: edgesRef.current }, clip, offset)
      setNodes(r.graph.nodes)
      setEdges(r.graph.edges.map((e) => (e.selected ? { ...e, selected: false } : e)))
      dirty()
    },
    [dirty, setEdges],
  )

  const copySelected = useCallback(() => {
    const clip = copySelection({ nodes: nodesRef.current, edges: edgesRef.current }, selectedIds, meta.current.entry, flowId)
    if (!clip) return false
    writeClipboard(clip)
    pasteCount.current = 0
    notify('flow-copied', t('clipboard.copied', { n: clip.nodes.length }))
    return true
  }, [flowId, selectedIds, t])

  const pasteClipboard = useCallback(() => {
    const clip = readClipboard()
    if (!clip) return
    pasteCount.current += 1
    doPaste(clip, PASTE_OFFSET * pasteCount.current)
  }, [doPaste])

  const requestDelete = useCallback(() => {
    const nodeIds = [...selectedIds].filter((id) => id !== meta.current.entry)
    const edgeIds = edgesRef.current.filter((e) => e.selected).map((e) => e.id)
    if (nodeIds.length || edgeIds.length) setDeleting({ nodeIds, edgeIds })
  }, [selectedIds])

  const confirmDelete = () => {
    if (!deleting) return
    const g = removeNodes({ nodes: nodesRef.current, edges: edgesRef.current }, new Set(deleting.nodeIds), meta.current.entry)
    const dropEdges = new Set(deleting.edgeIds)
    setNodes(g.nodes)
    setEdges(g.edges.filter((e) => !dropEdges.has(e.id)))
    setDeleting(null)
    dirty()
  }

  // Atalhos (06 §2.2): Ctrl/Cmd+C, Ctrl/Cmd+V, Delete/Backspace — fora de campos de texto e de diálogos.
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (deleting) return
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'c') {
        if (copySelected()) e.preventDefault()
      } else if (mod && key === 'v') {
        e.preventDefault()
        pasteClipboard()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        requestDelete()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [copySelected, deleting, pasteClipboard, readOnly, requestDelete])

  // Mudança de outra pessoa: salva o pendente e recarrega o rascunho (06 §7).
  useEffect(
    () =>
      onGraphUpdated(flowId, async (ev) => {
        if (!isForeign(ev, me)) return
        if (saver.pending) await saver.flush().catch(() => undefined)
        try {
          const fresh = await qc.fetchQuery({ ...bundleQuery(flowId), staleTime: 0 })
          const selected = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
          const g = toGraph(fresh.definition)
          meta.current = metaOf(fresh.definition)
          setNodes(g.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n)))
          setEdges(g.edges)
          setFlow(fresh.flow)
        } catch {
          // a próxima mudança tenta de novo
        }
      }),
    [flowId, me, qc, saver, setEdges],
  )

  const nodeActions = useMemo<NodeActions>(
    () => ({
      readOnly,
      onCopy: (id) => {
        const clip = copySelection({ nodes: nodesRef.current, edges: edgesRef.current }, new Set([id]), meta.current.entry, flowId)
        if (clip) doPaste(clip, PASTE_OFFSET)
      },
      onDelete: (id) => {
        if (id !== meta.current.entry) setDeleting({ nodeIds: [id], edgeIds: [] })
      },
    }),
    [doPaste, flowId, readOnly],
  )

  const updateNode = (id: string, patch: { name?: string; description?: string }) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    dirty()
  }
  const updateActions = (id: string, actions: FlowAction[]) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, actions } } : n)))
    dirty()
  }

  const activate = async () => {
    setBusy(true)
    try {
      await saver.flush()
      const r = await flowApi.activate(flowId)
      if (r.ok) {
        setFlow(r.flow)
        setIssues([])
        setNodes((ns) => withErrors(ns, {}))
        notify('flow-activated', t('status.activated'))
      } else {
        setIssues(r.issues)
        setNodes((ns) => withErrors(ns, errorsByNode(r.issues)))
      }
    } catch {
      notify('flow-action-error', t('editor.actionError'))
    } finally {
      setBusy(false)
    }
  }

  const pause = async () => {
    setBusy(true)
    try {
      setFlow(await flowApi.pause(flowId))
    } catch {
      notify('flow-action-error', t('editor.actionError'))
    } finally {
      setBusy(false)
    }
  }

  const rename = async (name: string) => {
    try {
      const updated = await flowApi.rename(flowId, name)
      setFlow(updated)
      qc.setQueryData<EditorBundle>(bundleKey(flowId), (b) => (b ? { ...b, flow: updated } : b))
    } catch {
      notify('flow-action-error', t('editor.actionError'))
    }
  }

  const focusNode = (id: string) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    setNodes((ns) => ns.map((x) => ({ ...x, selected: x.id === id })))
    void rf.setCenter(n.position.x + NODE_WIDTH / 2, n.position.y + 40, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 })
  }

  const savedLabel = (() => {
    if (status.state === 'saving') return t('save.saving')
    if (status.state === 'error') return t('save.error')
    if (status.savedAt) return t('save.savedAt', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(status.savedAt) })
    return ''
  })()

  const properties = (
    <PropertiesPanel
      flow={flow}
      node={selectedNode}
      stats={{ nodes: nodes.length, edges: edges.length }}
      readOnly={readOnly}
      onNodeChange={updateNode}
      onActionsChange={updateActions}
      className="w-full"
    />
  )

  return (
    <section data-testid="flow-editor" data-readonly={readOnly ? 'true' : 'false'} className="flex h-[calc(100dvh-10rem)] min-h-[28rem] w-full min-w-0 flex-col gap-3 lg:h-[calc(100dvh-5rem)]">
      <header className="flex flex-wrap items-center gap-2">
        <FlowTitle name={flow.name} readOnly={readOnly} onRename={rename} />
        <StatusBadge status={flow.status} />
        <span data-testid="flow-save-status" data-state={status.state} role="status" className={cn('text-xs text-muted-foreground', status.state === 'error' && 'text-destructive')}>
          {savedLabel}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mode === 'view' && canEditFlows ? (
            <Link
              to="/flows/$flowId/edit"
              params={{ flowId }}
              data-testid="flow-edit-link"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-accent"
            >
              <Pencil className="size-4" aria-hidden /> {t('editor.edit')}
            </Link>
          ) : null}
          {!readOnly ? (
            flow.status === 'active' ? (
              <Button size="sm" variant="outline" data-testid="flow-pause" disabled={busy} onClick={() => void pause()}>
                <Pause aria-hidden /> {t('status.pause')}
              </Button>
            ) : (
              <Button size="sm" data-testid="flow-activate" disabled={busy || flow.status === 'archived'} onClick={() => void activate()}>
                <Play aria-hidden /> {t('status.activate')}
              </Button>
            )
          ) : null}
          <Button size="sm" variant="outline" className="lg:hidden" data-testid="flow-properties-toggle" aria-expanded={propsOpen} onClick={() => setPropsOpen(!propsOpen)}>
            <SlidersHorizontal aria-hidden /> <span className="sr-only">{t('properties.title')}</span>
          </Button>
        </div>
      </header>

      {readOnly ? (
        <p data-testid="flow-readonly-notice" className="rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          {mode === 'view' ? t('editor.viewOnly') : t('editor.noPermission')}
        </p>
      ) : null}

      {issues.length ? (
        <div data-testid="flow-errors" role="alert" className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <p className="font-semibold text-destructive">{t('errors.title', { n: issues.length })}</p>
          <ul className="flex flex-col gap-0.5">
            {issues.map((i, idx) => (
              <li key={idx}>
                <button
                  type="button"
                  data-testid={`flow-error-${idx}`}
                  onClick={() => i.nodeId && focusNode(i.nodeId)}
                  className="text-left text-xs text-destructive hover:underline disabled:no-underline"
                  disabled={!i.nodeId}
                >
                  {i.nodeId ? `${nodes.find((n) => n.id === i.nodeId)?.data.name ?? i.nodeId}: ` : ''}
                  {i.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 gap-3">
        <div ref={wrapper} data-testid="flow-canvas" className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-muted/20">
          <NodeActionsContext.Provider value={nodeActions}>
            <ReactFlow<EditorNode, EditorEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => onEdgesChange(changes.filter((c) => c.type !== 'remove'))}
              onConnect={onConnect}
              onNodeDragStop={() => dirty()}
              onDrop={onDrop}
              onDragOver={onDragOver}
              minZoom={0.02}
              maxZoom={2}
              fitView
              fitViewOptions={{ padding: 0.6, maxZoom: 1 }}
              panOnScroll={false}
              deleteKeyCode={null}
              multiSelectionKeyCode="Shift"
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              elementsSelectable
              connectionRadius={30}
              colorMode="system"
            >
              <Background gap={20} />
              <MiniMap pannable zoomable className="max-lg:!hidden" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </NodeActionsContext.Provider>

          {!readOnly && !paletteOpen ? (
            <Button size="sm" className="absolute top-3 left-3 z-10 shadow" data-testid="flow-palette-toggle" aria-expanded={paletteOpen} onClick={() => setPaletteOpen(true)}>
              <Plus aria-hidden /> {t('palette.open')}
            </Button>
          ) : null}
          {!readOnly && paletteOpen ? (
            <Palette
              onAdd={addAtCenter}
              onClose={() => setPaletteOpen(false)}
              className="max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:max-h-[60dvh] max-lg:rounded-b-none lg:absolute lg:top-3 lg:left-3 lg:z-10 lg:max-h-[calc(100%-1.5rem)] lg:w-72"
            />
          ) : null}
          {!readOnly && selectedEdge ? (
            <Button
              size="sm"
              variant="destructive"
              className="absolute top-3 right-3 z-10 shadow"
              data-testid="flow-edge-delete"
              onClick={() => setDeleting({ nodeIds: [], edgeIds: [selectedEdge.id] })}
            >
              <Trash2 aria-hidden /> {t('edge.delete')}
            </Button>
          ) : null}
        </div>
        <div className="hidden w-80 shrink-0 lg:flex">{properties}</div>
      </div>

      {propsOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[70dvh] lg:hidden">
          <PropertiesPanel
            flow={flow}
            node={selectedNode}
            stats={{ nodes: nodes.length, edges: edges.length }}
            readOnly={readOnly}
            onNodeChange={updateNode}
            onActionsChange={updateActions}
            onClose={() => setPropsOpen(false)}
            className="w-full rounded-b-none shadow-xl"
          />
        </div>
      ) : null}

      <DeleteDialog request={deleting} nodes={nodes} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
    </section>
  )
}

function FlowTitle({ name, readOnly, onRename }: { name: string; readOnly: boolean; onRename: (name: string) => void }) {
  const t = useT('flow-editor')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  if (editing && !readOnly)
    return (
      <input
        data-testid="flow-title-input"
        autoFocus
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-sm"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (draft.trim() && draft.trim() !== name) onRename(draft.trim())
          else setDraft(name)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(name)
            setEditing(false)
          }
        }}
      />
    )
  return (
    <h1
      data-testid="flow-title"
      title={readOnly ? undefined : t('editor.renameHint')}
      tabIndex={readOnly ? undefined : 0}
      onClick={() => !readOnly && setEditing(true)}
      onKeyDown={(e) => !readOnly && e.key === 'Enter' && setEditing(true)}
      className={cn('min-w-0 truncate text-lg font-semibold', !readOnly && 'cursor-text rounded px-1 hover:bg-accent')}
    >
      {name}
    </h1>
  )
}

const STATUS_CLASS: Record<FlowStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  paused: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  archived: 'bg-muted text-muted-foreground',
}

function StatusBadge({ status }: { status: FlowStatus }) {
  const t = useT('flow-editor')
  return (
    <span data-testid="flow-status" data-status={status} className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[status])}>
      {t(`status.${status}`)}
    </span>
  )
}

function DeleteDialog({ request, nodes, onCancel, onConfirm }: { request: DeleteRequest | null; nodes: EditorNode[]; onCancel: () => void; onConfirm: () => void }) {
  const t = useT('flow-editor')
  const body = (() => {
    if (!request) return ''
    if (request.nodeIds.length === 1 && !request.edgeIds.length)
      return t('delete.oneNode', { name: nodes.find((n) => n.id === request.nodeIds[0])?.data.name ?? '' })
    if (request.nodeIds.length) return t('delete.manyNodes', { n: request.nodeIds.length })
    return t('delete.edges', { n: request.edgeIds.length })
  })()
  return (
    <Dialog.Root open={!!request} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="flow-delete-confirm"
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('delete.title')}</Dialog.Title>
          <p className="text-sm text-muted-foreground">{body}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="flow-delete-confirm-cancel" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" data-testid="flow-delete-confirm-ok" onClick={onConfirm}>
              {t('delete.confirm')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
