// Editor de fluxos (T45): página do editor/leitura, realtime e o registro de editores de nó (T56/T57).
export { FlowEditorPage } from './canvas/editor'
export { registerFlowEditorRealtime } from './canvas/realtime'
export { getNodeEditor, registerNodeEditor, type NodeEditor, type NodeEditorProps } from './node-editors/registry'
