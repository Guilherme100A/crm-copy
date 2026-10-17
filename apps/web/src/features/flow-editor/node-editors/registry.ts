// Registro dos editores de nó (contrato da T45 para T56/T57): cada tarefa registra o editor do seu tipo
// (`registerNodeEditor('message', MessageEditor)`) no carregamento do módulo; o painel de propriedades procura pelo
// tipo do nó e, sem editor registrado, mostra o fallback genérico (nome, descrição e lista de ações).
import type { ComponentType } from 'react'
import type { FlowAction } from '@crm/shared/flows'

export interface NodeEditorProps {
  nodeId: string
  /** Tipo do nó (`message`, `condition`…). */
  type: string
  actions: FlowAction[]
  readOnly: boolean
  /** Substitui as ações do nó (o editor salva com o autosave do canvas). */
  onChange: (actions: FlowAction[]) => void
}

export type NodeEditor = ComponentType<NodeEditorProps>

const editors = new Map<string, NodeEditor>()

/** Registra (ou troca) o editor de um tipo de nó. Devolve a função que desfaz o registro. */
export function registerNodeEditor(type: string, editor: NodeEditor): () => void {
  editors.set(type, editor)
  return () => {
    if (editors.get(type) === editor) editors.delete(type)
  }
}

/** Editor do tipo, ou `null` (o painel usa o fallback genérico). */
export function getNodeEditor(type: string): NodeEditor | null {
  return editors.get(type) ?? null
}

export const registeredNodeEditors = (): string[] => [...editors.keys()]

/**
 * Carga dos grupos (T56/T57): cada pasta `node-editors/<grupo>/index.ts` exporta
 *   export const nodeEditors: Record<string, NodeEditor> = { message: MessageEditor, … }
 * e é descoberta por glob (Vite), sem editar este arquivo. Os módulos do glob rodam ANTES deste corpo (imports
 * içados), então eles não chamam `registerNodeEditor` no topo nem importam valores daqui (só tipos).
 * Ordem por caminho; o último vence.
 */
export function collectNodeEditors(modules: Record<string, unknown>): Record<string, NodeEditor> {
  const out: Record<string, NodeEditor> = {}
  for (const path of Object.keys(modules).sort()) {
    const found = (modules[path] as { nodeEditors?: unknown } | undefined)?.nodeEditors
    if (!found || typeof found !== 'object') continue
    for (const [type, editor] of Object.entries(found)) if (typeof editor === 'function') out[type] = editor as NodeEditor
  }
  return out
}

for (const [type, editor] of Object.entries(collectNodeEditors(import.meta.glob('./*/index.ts', { eager: true })))) registerNodeEditor(type, editor)
