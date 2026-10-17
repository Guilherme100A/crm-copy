// `/agentes/:id` (07 §2): editor do agente com as abas na URL (`?tab=`) (T88).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { AgentEditorPage, editorSearchSchema, type EditorSearch } from '@/features/agents/editor-page'
import { registerAgentLabRealtime } from '@/features/agent-lab/realtime'
import { registerAgentsRealtime } from '@/features/agents/realtime'

registerAgentsRealtime()
registerAgentLabRealtime()

export const Route = createFileRoute('/agentes/$agentId')({
  validateSearch: editorSearchSchema,
  component: AgentRoute,
})

function AgentRoute() {
  const { agentId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: EditorSearch) => void navigate({ search: next, replace: true }), [navigate])
  return <AgentEditorPage agentId={agentId} search={search} onSearch={onSearch} />
}
