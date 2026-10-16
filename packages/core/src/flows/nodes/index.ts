// Registro dos grupos de nós (T25). Cada grupo pertence a uma tarefa, que troca o stub pelo seu `register…`
// (uma linha por grupo). Enquanto o grupo não existe, o nó lança `node_not_implemented:<tipo>`.
import type { NodeType } from '@crm/shared'
import type { NodeHandler } from '../engine/context'
import { notImplemented, type NodeRegistry } from '../engine/registry'
import { registerMessagingNodes } from './messaging/index'
import { registerCrmNodes as registerCrmGroup } from './crm/index'
import { registerInteractiveNodes as registerInteractiveGroup } from './interactive/index'
import { registerLogicNodes as registerLogicGroup } from './logic/index'

/** Grupo → tarefa dona e tipos de nó (06 §3.5; SPEC T41, T42, T51, T62, T63, T104, T111). */
export const NODE_GROUPS = {
  logic: { task: 'T41', types: ['condition', 'distributor', 'connection_flow', 'smart_interval'] },
  external: { task: 'T42', types: ['integration', 'ai'] },
  messages: { task: 'T51', types: ['message', 'notification', 'pix'] },
  interactive: { task: 'T62', types: ['interactive_menu', 'menu', 'carousel', 'wait_response'] },
  crm: { task: 'T63', types: ['tags', 'chat_controller', 'department', 'kanban', 'manipulator', 'approved_sale', 'ai_agent'] },
  pixel: { task: 'T104', types: ['pixel'] },
  payment: { task: 'T111', types: ['payment'] },
} as const satisfies Record<string, { task: string; types: readonly Exclude<NodeType, 'start'>[] }>

export type NodeGroup = keyof typeof NODE_GROUPS

/** Início: segue a única saída. */
export const startHandler: NodeHandler = {
  execute: () => ({ next: 'source' }),
}

function registerStub(group: NodeGroup) {
  return (registry: NodeRegistry) => {
    for (const type of NODE_GROUPS[group].types) registry.register(type, notImplemented(type))
    return registry
  }
}

// Uma linha por grupo: a tarefa dona troca `registerStub('<grupo>')` pelo registrador real.
const registerLogicNodes = (registry: NodeRegistry) => registerLogicGroup(registry) // T41
const registerExternalNodes = registerStub('external') // T42
const registerMessageNodes = (registry: NodeRegistry) => registerMessagingNodes(registry) // T51
const registerInteractiveNodes = (registry: NodeRegistry) => registerInteractiveGroup(registry) // T62
const registerCrmNodes = (registry: NodeRegistry) => registerCrmGroup(registry) // T63
const registerPixelNodes = registerStub('pixel') // T104
const registerPaymentNodes = registerStub('payment') // T111

export function registerNodeGroups(registry: NodeRegistry): NodeRegistry {
  registry.register('start', startHandler)
  for (const register of [
    registerLogicNodes,
    registerExternalNodes,
    registerMessageNodes,
    registerInteractiveNodes,
    registerCrmNodes,
    registerPixelNodes,
    registerPaymentNodes,
  ])
    register(registry)
  return registry
}
