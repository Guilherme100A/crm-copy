// `/agentes/novo` (07 §2): editor em modo criação; salvar cria o agente e abre `/agentes/:id` (T88).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { AgentEditorPage, editorSearchSchema, type EditorSearch } from '@/features/agents/editor-page'
import { registerAgentLabRealtime } from '@/features/agent-lab/realtime'
import { registerAgentsRealtime } from '@/features/agents/realtime'

registerAgentsRealtime()
registerAgentLabRealtime()

export const Route = createFileRoute('/agentes/novo')({
  validateSearch: editorSearchSchema,
  component: NewAgentRoute,
})

function NewAgentRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: EditorSearch) => void navigate({ search: next, replace: true }), [navigate])
  return <AgentEditorPage agentId={null} search={search} onSearch={onSearch} />
}
