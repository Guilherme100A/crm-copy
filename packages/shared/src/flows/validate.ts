import type { z } from 'zod'
import { getActionSchema, isSupportedActionType, UNSUPPORTED_ACTION_TYPES } from './actions'
import { FlowDefinitionSchema, type FlowDefinition, type FlowEdge, type FlowNode } from './definition'
import { isWaitingHandle, nodeHandles } from './handles'
import { isNodeType, NODE_ACTIONS, NODE_PRIMARY_ACTIONS, SINGLE_PRIMARY_NODES, UNSUPPORTED_NODE, type NodeType } from './nodes'

export const FLOW_ERROR_CODES = [
  'invalid_definition',
  'duplicate_node_id',
  'duplicate_edge_id',
  'missing_start',
  'multiple_start',
  'entry_not_start',
  'no_node_after_start',
  'start_has_incoming',
  'edge_unknown_node',
  'invalid_handle',
  'duplicate_edge_handle',
  'unreachable_node',
  'cycle_without_wait',
  'unsupported_node',
  'unsupported_action',
  'action_not_allowed',
  'missing_action',
  'duplicate_action',
  'invalid_action_config',
] as const
export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number]

export interface FlowValidationError {
  /** Nó a que o erro se refere (badge no editor); `null` quando é do fluxo inteiro. */
  nodeId: string | null
  code: FlowErrorCode
  message: string
  actionId?: string
  edgeId?: string
  /** Caminho dentro da config da ação (invalid_action_config) ou da definição (invalid_definition). */
  path?: (string | number)[]
}

const isUnsupportedNode = (node: FlowNode) => !isNodeType(node.type)

const issuePath = (issue: z.core.$ZodIssue) => issue.path.filter((p): p is string | number => typeof p !== 'symbol')

/**
 * Valida um fluxo e devolve TODOS os erros, cada um com o `nodeId` (lista vazia = válido).
 * Não altera a definição recebida.
 */
export function validate(input: unknown): FlowValidationError[] {
  const parsed = FlowDefinitionSchema.safeParse(input)
  if (!parsed.success) return structureErrors(input, parsed.error.issues)
  const def = parsed.data
  const errors: FlowValidationError[] = []
  const push = (e: FlowValidationError) => errors.push(e)

  // Nós
  const nodes = new Map<string, FlowNode>()
  for (const node of def.nodes) {
    if (nodes.has(node.id)) push({ nodeId: node.id, code: 'duplicate_node_id', message: `id de nó repetido: ${node.id}` })
    else nodes.set(node.id, node)
  }

  const starts = def.nodes.filter((n) => n.type === 'start')
  if (starts.length === 0) push({ nodeId: null, code: 'missing_start', message: 'o fluxo precisa de um nó Início' })
  for (const extra of starts.slice(1)) push({ nodeId: extra.id, code: 'multiple_start', message: 'o fluxo só pode ter um nó Início' })
  const entry = nodes.get(def.entry)
  const entryOk = entry?.type === 'start'
  if (!entryOk) push({ nodeId: entry ? entry.id : null, code: 'entry_not_start', message: '`entry` precisa apontar para o nó Início' })

  for (const node of nodes.values()) validateNode(node, push)

  // Arestas
  const edgeIds = new Set<string>()
  const used = new Set<string>()
  const valid: FlowEdge[] = []
  for (const edge of def.edges) {
    if (edgeIds.has(edge.id)) push({ nodeId: edge.from, code: 'duplicate_edge_id', edgeId: edge.id, message: `id de aresta repetido: ${edge.id}` })
    edgeIds.add(edge.id)
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to) {
      push({ nodeId: from ? from.id : null, code: 'edge_unknown_node', edgeId: edge.id, message: `aresta ${edge.id} liga a um nó inexistente` })
      continue
    }
    if (to.type === 'start') push({ nodeId: to.id, code: 'start_has_incoming', edgeId: edge.id, message: 'o nó Início não recebe conexões' })
    if (!isUnsupportedNode(from) && !nodeHandles(from).includes(edge.handle)) {
      push({ nodeId: from.id, code: 'invalid_handle', edgeId: edge.id, message: `o nó não tem a saída "${edge.handle}"` })
    }
    const key = `${edge.from}\u0000${edge.handle}`
    if (used.has(key)) {
      push({ nodeId: from.id, code: 'duplicate_edge_handle', edgeId: edge.id, message: `a saída "${edge.handle}" já está conectada` })
      continue
    }
    used.add(key)
    valid.push(edge)
  }

  if (entryOk && !valid.some((e) => e.from === entry.id && e.to !== entry.id)) {
    push({ nodeId: entry.id, code: 'no_node_after_start', message: 'Adicione pelo menos um nó após o Início para salvar o fluxo' })
  }

  if (entryOk) {
    const reached = reachable(entry.id, valid)
    for (const node of nodes.values()) {
      if (!reached.has(node.id) && node.type !== 'start') push({ nodeId: node.id, code: 'unreachable_node', message: 'nó não é alcançado a partir do Início' })
    }
  }

  for (const id of cycleNodes(nodes, valid)) {
    push({ nodeId: id, code: 'cycle_without_wait', message: 'laço sem espera (resposta, prazo ou intervalo) repetiria sem fim' })
  }

  return errors
}

/** Fluxo só pode ser ativado sem nenhum erro (inclui `unsupported_node`). */
export function canActivate(def: unknown): boolean {
  return validate(def).length === 0
}

function validateNode(node: FlowNode, push: (e: FlowValidationError) => void) {
  if (isUnsupportedNode(node)) {
    const original = node.type === UNSUPPORTED_NODE ? (node.original_type ?? 'desconhecido') : node.type
    push({ nodeId: node.id, code: 'unsupported_node', message: `o bloco "${original}" não é suportado nesta versão; remova-o para ativar o fluxo` })
    return
  }
  const type: NodeType = node.type as NodeType
  const allowed = NODE_ACTIONS[type]
  const primary = NODE_PRIMARY_ACTIONS[type]
  let primaryCount = 0
  for (const action of node.actions) {
    if (!isSupportedActionType(action.type)) {
      const outOfScope = (UNSUPPORTED_ACTION_TYPES as readonly string[]).includes(action.type)
      push({
        nodeId: node.id,
        code: 'unsupported_action',
        actionId: action.id,
        message: outOfScope ? `a ação "${action.type}" não é suportada nesta versão` : `ação desconhecida: ${action.type}`,
      })
      continue
    }
    if (!allowed.includes(action.type)) {
      push({ nodeId: node.id, code: 'action_not_allowed', actionId: action.id, message: `a ação "${action.type}" não pertence ao bloco "${type}"` })
      continue
    }
    if (primary.includes(action.type)) primaryCount++
    const result = getActionSchema(action.type)?.safeParse(action.config)
    if (result && !result.success) {
      const first = result.error.issues[0]
      push({
        nodeId: node.id,
        code: 'invalid_action_config',
        actionId: action.id,
        path: first ? issuePath(first) : [],
        message: result.error.issues.map((i) => (i.path.length ? `${issuePath(i).join('.')}: ${i.message}` : i.message)).join('; '),
      })
    }
  }
  if (type !== 'start' && primaryCount === 0) push({ nodeId: node.id, code: 'missing_action', message: `o bloco precisa de uma ação ${primary.join(' ou ')}` })
  if (SINGLE_PRIMARY_NODES.includes(type) && primaryCount > 1) push({ nodeId: node.id, code: 'duplicate_action', message: 'o bloco só pode ter uma ação principal' })
}

function structureErrors(input: unknown, issues: z.core.$ZodIssue[]): FlowValidationError[] {
  const rawNodes = (input && typeof input === 'object' && Array.isArray((input as { nodes?: unknown }).nodes) ? (input as { nodes: unknown[] }).nodes : []) as unknown[]
  return issues.map((issue) => {
    const path = issuePath(issue)
    let nodeId: string | null = null
    if (path[0] === 'nodes' && typeof path[1] === 'number') {
      const raw = rawNodes[path[1]] as { id?: unknown } | undefined
      if (typeof raw?.id === 'string') nodeId = raw.id
    }
    return { nodeId, code: 'invalid_definition' as const, path, message: path.length ? `${path.join('.')}: ${issue.message}` : issue.message }
  })
}

function reachable(from: string, edges: FlowEdge[]): Set<string> {
  const out = new Map<string, string[]>()
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const seen = new Set([from])
  const stack = [from]
  while (stack.length) {
    for (const next of out.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return seen
}

/** Nós em componentes fortemente conexos formados só por arestas que não esperam (Tarjan, iterativo). */
function cycleNodes(nodes: Map<string, FlowNode>, edges: FlowEdge[]): string[] {
  const out = new Map<string, string[]>()
  const selfLoop = new Set<string>()
  for (const e of edges) {
    const from = nodes.get(e.from)!
    if (isWaitingHandle(from.type, e.handle)) continue
    if (e.from === e.to) selfLoop.add(e.from)
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  }

  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[] = []

  for (const root of nodes.keys()) {
    if (index.has(root)) continue
    const work: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    index.set(root, counter)
    low.set(root, counter++)
    stack.push(root)
    onStack.add(root)
    while (work.length) {
      const frame = work[work.length - 1]!
      const succ = out.get(frame.id) ?? []
      if (frame.next < succ.length) {
        const w = succ[frame.next++]!
        if (!index.has(w)) {
          index.set(w, counter)
          low.set(w, counter++)
          stack.push(w)
          onStack.add(w)
          work.push({ id: w, next: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(w)!))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!))
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          component.push(w)
        } while (w !== frame.id)
        if (component.length > 1 || selfLoop.has(frame.id)) result.push(...component.reverse())
      }
    }
  }
  return result
}

export type { FlowDefinition }
