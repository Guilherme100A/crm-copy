// Grupo "CRM" da T57 (T63): Etiquetas, Controlador de chat, Departamento, Kanban, Manipulador e Agente de IA. A Venda
// aprovada (`approved_sale`) é da T114. Carregado pelo glob de `node-editors/registry.ts` (só o tipo vem de lá).
import type { NodeEditor } from '../registry'
import { KanbanEditor } from './kanban-editor'
import { ManipulatorEditor } from './manipulator-editor'
import { AiAgentEditor, ChatControllerEditor, DepartmentEditor } from './simple-editors'
import { TagsEditor } from './tags-editor'

export const nodeEditors: Record<string, NodeEditor> = {
  tags: TagsEditor,
  chat_controller: ChatControllerEditor,
  department: DepartmentEditor,
  kanban: KanbanEditor,
  manipulator: ManipulatorEditor,
  ai_agent: AiAgentEditor,
}
