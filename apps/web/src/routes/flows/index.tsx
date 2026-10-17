// `/flows` (06 §2.1; permissão flows.view): lista de fluxos e pastas com a pasta, a busca, o status e a visão nos
// search params tipados (T44).
import { createFileRoute } from '@tanstack/react-router'
import { useCallback } from 'react'
import { FlowsPage } from '@/features/flows/flows-page'
import { flowsSearchSchema, type FlowsSearch } from '@/features/flows/view'

export const Route = createFileRoute('/flows/')({
  validateSearch: flowsSearchSchema,
  component: FlowsRoute,
})

/** Tira chaves vazias e a raiz implícita para a URL ficar limpa. */
const clean = (s: FlowsSearch): FlowsSearch =>
  Object.fromEntries(
    Object.entries(s).filter(([k, v]) => v !== undefined && v !== '' && !(k === 'folder' && v === 'root')),
  ) as FlowsSearch

function FlowsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  // Trocar de pasta entra no histórico (voltar do navegador); busca, filtro e visão substituem a entrada.
  const onSearch = useCallback(
    (next: FlowsSearch) =>
      void navigate({ search: clean(next), replace: (next.folder ?? 'root') === (search.folder ?? 'root') }),
    [navigate, search.folder],
  )
  return <FlowsPage search={search} onSearch={onSearch} />
}
