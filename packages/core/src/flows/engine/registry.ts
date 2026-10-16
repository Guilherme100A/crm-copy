// Registro de handlers por `node_type` (T25). `createNodeRegistry()` já vem com os grupos de `nodes/index.ts`
// (start real + stubs das tarefas de cada grupo); `register` sobrescreve (testes e as tarefas dos grupos).
import { registerNodeGroups } from '../nodes/index'
import type { NodeHandler } from './context'

export class NodeNotImplementedError extends Error {
  constructor(readonly nodeType: string) {
    super(`node_not_implemented:${nodeType}`)
    this.name = 'NodeNotImplementedError'
  }
}

export interface NodeRegistry {
  register(nodeType: string, handler: NodeHandler): NodeRegistry
  get(nodeType: string): NodeHandler | undefined
  has(nodeType: string): boolean
  types(): string[]
}

export function createEmptyNodeRegistry(): NodeRegistry {
  const handlers = new Map<string, NodeHandler>()
  const reg: NodeRegistry = {
    register(nodeType, handler) {
      handlers.set(nodeType, handler)
      return reg
    },
    get: (nodeType) => handlers.get(nodeType),
    has: (nodeType) => handlers.has(nodeType),
    types: () => [...handlers.keys()],
  }
  return reg
}

/** Registry com os grupos padrão (start + stubs). */
export function createNodeRegistry(): NodeRegistry {
  return registerNodeGroups(createEmptyNodeRegistry())
}

/** Handler que lança `node_not_implemented:<tipo>` (segue `failure` se houver, senão o run falha). */
export function notImplemented(nodeType: string): NodeHandler {
  return {
    execute() {
      throw new NodeNotImplementedError(nodeType)
    },
  }
}
