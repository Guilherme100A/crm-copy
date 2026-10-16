// `/agentes` (07 §2; permissão flows.view): lista de agentes e aba Vozes, com aba e filtro nos search params (T88).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { AgentsListPage, agentsSearchSchema, type AgentsSearch } from '@/features/agents/list-page'
import { registerAgentsRealtime } from '@/features/agents/realtime'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerAgentsRealtime()

export const Route = createFileRoute('/agentes/')({
  validateSearch: agentsSearchSchema,
  component: AgentsRoute,
})

function AgentsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: AgentsSearch) => void navigate({ search: next, replace: true }), [navigate])
  return <AgentsListPage search={search} onSearch={onSearch} />
}
