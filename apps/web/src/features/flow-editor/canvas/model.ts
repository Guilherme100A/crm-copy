// Modelo do editor (T45; 06 §2.2, §5.2–5.4): converte a FlowDefinition v1 (formato próprio, validado por zod no
// servidor) em nós/arestas do xyflow e de volta, sem levar estado de UI (`selected`, `measured`, `dragging`).
// Ligar uma saída já ligada substitui a aresta; colar duplica nós e arestas internas com ids novos e +50/+50.
import { FlowDefinitionSchema, nodeHandles, type FlowAction, type FlowDefinition, type FlowEdge, type FlowNode } from '@crm/shared/flows'
import type { Edge, Node } from '@xyflow/react'

export interface FlowNodeData extends Record<string, unknown> {
  name: string
  description?: string
  actions: FlowAction[]
  original_type?: string
  /** Erros de validação do nó (da última tentativa de ativar). */
  errors?: string[]
  isEntry?: boolean
}

export type EditorNode = Node<FlowNodeData, string>
export type EditorEdge = Edge

export interface EditorGraph {
  nodes: EditorNode[]
  edges: EditorEdge[]
}

/** Partes da definição que o canvas não edita (entrada, variáveis, refs). */
export type DefinitionMeta = Pick<FlowDefinition, 'schema' | 'entry' | 'variables' | 'refs'>

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Id gerado no cliente (`n_` / `e_` / `a_` + 10 caracteres), aceito pela API (`[A-Za-z0-9_-]{1,64}`). */
export function newId(prefix: 'n' | 'e' | 'a', random: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 10; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)]
  return `${prefix}_${s}`
}

export const metaOf = (def: FlowDefinition): DefinitionMeta => ({ schema: def.schema, entry: def.entry, variables: def.variables, refs: def.refs })

export function toGraph(def: FlowDefinition, errors: Record<string, string[]> = {}): EditorGraph {
  return {
    nodes: def.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y },
      deletable: n.id !== def.entry,
      data: {
        name: n.name,
        ...(n.description !== undefined ? { description: n.description } : {}),
        actions: n.actions,
        ...(n.original_type ? { original_type: n.original_type } : {}),
        ...(errors[n.id]?.length ? { errors: errors[n.id] } : {}),
        isEntry: n.id === def.entry,
      },
    })),
    edges: def.edges.map(toEdge),
  }
}

export const toEdge = (e: FlowEdge): EditorEdge => ({ id: e.id, source: e.from, sourceHandle: e.handle, target: e.to })

const round = (v: number) => Math.round(v)

/** Grafo do canvas → definição (posições arredondadas; arestas sem handle de saída são descartadas). */
export function toDefinition(graph: EditorGraph, meta: DefinitionMeta): FlowDefinition {
  const nodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type ?? 'message',
    name: n.data.name,
    ...(n.data.description ? { description: n.data.description } : {}),
    position: { x: round(n.position.x), y: round(n.position.y) },
    actions: n.data.actions,
    ...(n.data.original_type ? { original_type: n.data.original_type } : {}),
  }))
  const ids = new Set(nodes.map((n) => n.id))
  const edges: FlowEdge[] = graph.edges
    .filter((e) => e.sourceHandle && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ id: e.id, from: e.source, handle: e.sourceHandle!, to: e.target }))
  return { ...meta, nodes, edges }
}

/** A definição bate com o schema v1 (o servidor confere de novo). */
export const isValidDefinition = (def: unknown): def is FlowDefinition => FlowDefinitionSchema.safeParse(def).success

/** Handles de saída do nó (tipo + config). */
export const outputHandles = (node: Pick<EditorNode, 'type' | 'data'>): string[] => nodeHandles({ type: node.type ?? '', actions: node.data.actions })

export interface Connect {
  source: string
  sourceHandle: string | null
  target: string
}

/**
 * Liga `source:handle → target`. Uma saída só tem uma aresta: a anterior daquela saída é removida (AC-T45-02).
 * Recusa ligar ao próprio nó e ao nó de entrada (Início não recebe conexões).
 */
export function connect(edges: readonly EditorEdge[], c: Connect, entry: string, makeId: () => string = () => newId('e')): EditorEdge[] | null {
  if (!c.sourceHandle || c.source === c.target || c.target === entry) return null
  const kept = edges.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle))
  return [...kept, { id: makeId(), source: c.source, sourceHandle: c.sourceHandle, target: c.target }]
}

/** Remove nós (exceto a entrada) e as arestas ligadas a eles. */
export function removeNodes(graph: EditorGraph, ids: ReadonlySet<string>, entry: string): EditorGraph {
  const drop = new Set([...ids].filter((id) => id !== entry))
  return {
    nodes: graph.nodes.filter((n) => !drop.has(n.id)),
    edges: graph.edges.filter((e) => !drop.has(e.source) && !drop.has(e.target)),
  }
}

export interface ClipboardPayload {
  version: 1
  sourceFlowId: string
  nodes: { id: string; type: string; position: { x: number; y: number }; data: Pick<FlowNodeData, 'name' | 'description' | 'actions' | 'original_type'> }[]
  edges: { from: string; handle: string; to: string }[]
}

export const PASTE_OFFSET = 50

/** Copia os nós selecionados (sem a entrada) e as arestas entre eles. */
export function copySelection(graph: EditorGraph, selected: ReadonlySet<string>, entry: string, flowId: string): ClipboardPayload | null {
  const nodes = graph.nodes.filter((n) => selected.has(n.id) && n.id !== entry)
  if (!nodes.length) return null
  const ids = new Set(nodes.map((n) => n.id))
  return {
    version: 1,
    sourceFlowId: flowId,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? 'message',
      position: { ...n.position },
      data: { name: n.data.name, description: n.data.description, actions: n.data.actions, original_type: n.data.original_type },
    })),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.sourceHandle).map((e) => ({ from: e.source, handle: e.sourceHandle!, to: e.target })),
  }
}

/** Cola com ids novos (nós, ações e arestas), deslocamento `offset` e os colados selecionados. */
export function paste(
  graph: EditorGraph,
  clip: ClipboardPayload,
  offset: number,
  makeId: (p: 'n' | 'e' | 'a') => string = newId,
): { graph: EditorGraph; pasted: string[] } {
  const map = new Map<string, string>()
  for (const n of clip.nodes) map.set(n.id, makeId('n'))
  const nodes: EditorNode[] = clip.nodes.map((n) => ({
    id: map.get(n.id)!,
    type: n.type,
    position: { x: n.position.x + offset, y: n.position.y + offset },
    selected: true,
    data: { ...n.data, actions: n.data.actions.map((a) => ({ ...a, id: makeId('a'), config: structuredClone(a.config) })) },
  }))
  const edges: EditorEdge[] = clip.edges.map((e) => ({ id: makeId('e'), source: map.get(e.from)!, sourceHandle: e.handle, target: map.get(e.to)! }))
  return {
    graph: { nodes: [...graph.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...nodes], edges: [...graph.edges, ...edges] },
    pasted: nodes.map((n) => n.id),
  }
}

export const CLIPBOARD_KEY = 'crm.flowClipboard.v1'

export function parseClipboard(raw: string | null): ClipboardPayload | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as ClipboardPayload
    return v && v.version === 1 && Array.isArray(v.nodes) && Array.isArray(v.edges) ? v : null
  } catch {
    return null
  }
}

export interface ValidationIssue {
  nodeId: string | null
  code: string
  message: string
}

/** Erros da ativação agrupados por nó (badge) — os do fluxo inteiro ficam só na lista. */
export function errorsByNode(issues: readonly ValidationIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const i of issues) if (i.nodeId) (out[i.nodeId] ??= []).push(i.message)
  return out
}

/** Aplica os erros nos dados dos nós (sem mexer no resto). */
export function withErrors(nodes: readonly EditorNode[], errors: Record<string, string[]>): EditorNode[] {
  return nodes.map((n) => {
    const e = errors[n.id]
    if (!e?.length && !n.data.errors) return n
    const { errors: _old, ...data } = n.data
    return { ...n, data: e?.length ? { ...data, errors: e } : data }
  })
}
