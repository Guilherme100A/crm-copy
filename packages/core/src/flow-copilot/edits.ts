// Edições do assistente de fluxo (T93, AC-T93-02) sobre a FlowDefinition em memória. Cada edição gera uma definição
// nova (a original não muda); quem grava confere antes os erros NOVOS de `validate` (T10) com `newValidationErrors`.
import { randomBytes } from 'node:crypto'
import {
  NODE_ACTIONS,
  isNodeType,
  parseHandle,
  type FlowDefinition,
  type FlowEdge,
  type FlowNode,
  type FlowValidationError,
} from '@crm/shared/flows'

/** Mesma forma das chaves geradas pela API de fluxos (`node_<hex>`). */
export const genCopilotKey = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`

/** Edição recusada antes de validar (nó inexistente, Início etc.): volta ao modelo como erro da ferramenta. */
export class FlowEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowEditError'
  }
}

export type FlowEdit =
  | {
      op: 'create_node'
      type: string
      name?: string
      position?: { x: number; y: number }
      actions?: { type: string; config: Record<string, unknown> }[]
      connect_from?: { node_id: string; handle: string }
    }
  | { op: 'update_action'; node_id: string; action_id: string; config: Record<string, unknown>; replace?: boolean }
  | { op: 'connect'; from: string; handle: string; to: string }
  | { op: 'disconnect'; from: string; handle: string }
  | { op: 'delete_node'; node_id: string }

/** Mutação publicada no `flow.graph_updated` (mesmos nomes das rotas de fluxos da T28). */
export const EDIT_MUTATION: Record<FlowEdit['op'], string> = {
  create_node: 'add_node',
  update_action: 'update_action',
  connect: 'add_connection',
  disconnect: 'delete_connection',
  delete_node: 'delete_node',
}

export interface EditResult {
  definition: FlowDefinition
  /** Ids criados/afetados, devolvidos ao modelo. */
  summary: Record<string, unknown>
}

const NODE_GAP_X = 360

function requireNode(def: FlowDefinition, id: string, path = 'node_id'): FlowNode {
  const node = def.nodes.find((n) => n.id === id)
  if (!node) throw new FlowEditError(`${path}: o nó "${id}" não existe neste fluxo`)
  return node
}

function upsertEdge(
  edges: FlowEdge[],
  from: string,
  handle: string,
  to: string,
): { edges: FlowEdge[]; edge: FlowEdge; replaced: string | null } {
  const existing = edges.find((e) => e.from === from && e.handle === handle)
  if (existing && existing.to === to) return { edges, edge: existing, replaced: null }
  const edge: FlowEdge = { id: genCopilotKey('edge'), from, handle, to }
  return { edges: [...edges.filter((e) => e !== existing), edge], edge, replaced: existing?.id ?? null }
}

function checkHandle(handle: string) {
  if (!parseHandle(handle))
    throw new FlowEditError(
      `handle: "${handle}" não é uma saída válida (use source, success, failure, timeout, other, option:<id> ou output:<id>)`,
    )
}

/** Aplica a edição e devolve a definição nova. Lança `FlowEditError` para pedidos impossíveis. */
export function applyFlowEdit(def: FlowDefinition, edit: FlowEdit): EditResult {
  switch (edit.op) {
    case 'create_node': {
      if (!isNodeType(edit.type) || edit.type === 'start')
        throw new FlowEditError(`type: "${edit.type}" não é um tipo de bloco que possa ser criado`)
      const parent = edit.connect_from ? requireNode(def, edit.connect_from.node_id, 'connect_from.node_id') : undefined
      if (edit.connect_from) checkHandle(edit.connect_from.handle)
      const maxX = def.nodes.reduce((m, n) => Math.max(m, n.position.x), 0)
      const position =
        edit.position ??
        (parent
          ? { x: parent.position.x + NODE_GAP_X, y: parent.position.y }
          : { x: maxX + NODE_GAP_X, y: def.nodes[0]?.position.y ?? 0 })
      const node: FlowNode = {
        id: genCopilotKey('node'),
        type: edit.type,
        name: edit.name?.trim() || edit.type,
        position,
        actions: (edit.actions ?? []).map((a, i) => ({
          id: genCopilotKey('action'),
          type: a.type,
          order: i,
          config: a.config,
        })),
      }
      let edges = def.edges
      let edgeId: string | undefined
      if (parent && edit.connect_from) {
        const r = upsertEdge(edges, parent.id, edit.connect_from.handle, node.id)
        edges = r.edges
        edgeId = r.edge.id
      }
      return {
        definition: { ...def, nodes: [...def.nodes, node], edges },
        summary: {
          node_id: node.id,
          action_ids: node.actions.map((a) => a.id),
          ...(edgeId ? { edge_id: edgeId } : {}),
        },
      }
    }
    case 'update_action': {
      const node = requireNode(def, edit.node_id)
      const action = node.actions.find((a) => a.id === edit.action_id)
      if (!action) throw new FlowEditError(`action_id: a ação "${edit.action_id}" não existe no nó "${node.id}"`)
      const config = edit.replace ? edit.config : { ...action.config, ...edit.config }
      const nodes = def.nodes.map((n) =>
        n !== node ? n : { ...n, actions: n.actions.map((a) => (a !== action ? a : { ...a, config })) },
      )
      return { definition: { ...def, nodes }, summary: { node_id: node.id, action_id: action.id } }
    }
    case 'connect': {
      const from = requireNode(def, edit.from, 'from')
      const to = requireNode(def, edit.to, 'to')
      checkHandle(edit.handle)
      if (to.type === 'start') throw new FlowEditError('to: o nó Início não recebe conexões')
      const r = upsertEdge(def.edges, from.id, edit.handle, to.id)
      return {
        definition: { ...def, edges: r.edges },
        summary: { edge_id: r.edge.id, ...(r.replaced ? { replaced_edge_id: r.replaced } : {}) },
      }
    }
    case 'disconnect': {
      requireNode(def, edit.from, 'from')
      const edge = def.edges.find((e) => e.from === edit.from && e.handle === edit.handle)
      if (!edge) throw new FlowEditError(`handle: a saída "${edit.handle}" do nó "${edit.from}" não está conectada`)
      return {
        definition: { ...def, edges: def.edges.filter((e) => e !== edge) },
        summary: { removed_edge_id: edge.id },
      }
    }
    case 'delete_node': {
      const node = requireNode(def, edit.node_id)
      if (node.type === 'start' || node.id === def.entry)
        throw new FlowEditError('node_id: o nó Início não pode ser removido')
      const removed = def.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => e.id)
      return {
        definition: {
          ...def,
          nodes: def.nodes.filter((n) => n !== node),
          edges: def.edges.filter((e) => e.from !== node.id && e.to !== node.id),
        },
        summary: { node_id: node.id, removed_edge_ids: removed },
      }
    }
  }
}

/**
 * Erros de rascunho em construção: o editor também deixa um bloco solto ou sem ação enquanto o fluxo é montado
 * (e o Início sem sucessor num fluxo vazio). Não bloqueiam a edição; a ativação continua exigindo zero erros.
 */
export const DRAFT_TOLERATED_CODES: readonly FlowValidationError['code'][] = [
  'unreachable_node',
  'no_node_after_start',
  'missing_action',
]

const errorKey = (e: FlowValidationError) =>
  [e.code, e.nodeId ?? '', e.actionId ?? '', e.edgeId ?? '', e.message].join('\u0000')

/** Erros que a edição criou (os que o rascunho já tinha antes não contam). */
export function newValidationErrors(
  before: FlowValidationError[],
  after: FlowValidationError[],
): FlowValidationError[] {
  const seen = new Set(before.map(errorKey))
  return after.filter((e) => !seen.has(errorKey(e)) && !DRAFT_TOLERATED_CODES.includes(e.code))
}

/** Resumo compacto do fluxo para o modelo (ids, tipos, ações, saídas possíveis, conexões e erros). */
export function describeFlow(def: FlowDefinition, errors: FlowValidationError[], handlesOf: (n: FlowNode) => string[]) {
  return {
    entry: def.entry,
    nodes: def.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      position: n.position,
      actions: n.actions.map((a) => ({ id: a.id, type: a.type, config: a.config })),
      handles: isNodeType(n.type) ? handlesOf(n) : [],
    })),
    edges: def.edges.map((e) => ({ id: e.id, from: e.from, handle: e.handle, to: e.to })),
    errors: errors.map((e) => ({ node_id: e.nodeId, code: e.code, message: e.message })),
  }
}

/** Catálogo de blocos para o modelo: tipo e ações aceitas. */
export function blockCatalog() {
  return Object.entries(NODE_ACTIONS)
    .filter(([type]) => type !== 'start')
    .map(([type, actions]) => ({ type, actions }))
}

export function formatValidationErrors(errors: FlowValidationError[]): string {
  return errors.map((e) => `${e.code}${e.nodeId ? ` (nó ${e.nodeId})` : ''}: ${e.message}`).join('; ')
}
