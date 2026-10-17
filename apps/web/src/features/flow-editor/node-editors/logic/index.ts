// Grupo "lógica" da T57 (T41): Condição, Distribuidor, Conexão de Fluxo e Intervalo Inteligente. Carregado pelo glob
// de `node-editors/registry.ts` (só o tipo vem de lá: o glob roda antes do corpo do registro).
import type { NodeEditor } from '../registry'
import { ConditionEditor } from './condition-editor'
import { ConnectionFlowEditor } from './connection-flow-editor'
import { DistributorEditor } from './distributor-editor'
import { SmartIntervalEditor } from './smart-interval-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  condition: ConditionEditor,
  distributor: DistributorEditor,
  connection_flow: ConnectionFlowEditor,
  smart_interval: SmartIntervalEditor,
}
