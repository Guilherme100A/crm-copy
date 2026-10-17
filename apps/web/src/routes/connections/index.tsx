// `/connections` (08 §2; permissão connections.view): busca, status e página nos search params (T71).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { connectionsSearchSchema, type ConnectionsSearch } from '@/features/connections/logic'
import { ConnectionsPage } from '@/features/connections/page'
import { registerConnectionsRealtime } from '@/features/connections/realtime'

// Handlers do SSE registrados junto com a árvore de rotas (antes de o shell abrir a conexão).
registerConnectionsRealtime()

export const Route = createFileRoute('/connections/')({
  validateSearch: connectionsSearchSchema,
  component: ConnectionsRoute,
})

function ConnectionsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const onSearch = useCallback((next: ConnectionsSearch) => void navigate({ search: next, replace: true }), [navigate])
  return <ConnectionsPage search={search} onSearch={onSearch} />
}
