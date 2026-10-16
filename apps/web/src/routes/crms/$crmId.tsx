// `/crms/$crmId` (spec 18; permissão kanban.view): quadro kanban arrastável (T70) com filtros na URL (T76).
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CrmBoardPage } from '@/features/crms/board-page'
import { registerCrmsRealtime } from '@/features/crms/realtime'
import { boardSearchSchema, cleanSearch, type BoardSearch } from '@/features/kanban-tools/filters'
import { registerKanbanToolsRealtime } from '@/features/kanban-tools/realtime'

registerCrmsRealtime()
registerKanbanToolsRealtime()

export const Route = createFileRoute('/crms/$crmId')({
  validateSearch: boardSearchSchema,
  component: CrmBoardRoute,
})

function CrmBoardRoute() {
  const { crmId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const onSearch = (next: BoardSearch) => void navigate({ search: cleanSearch(next), replace: true })
  return <CrmBoardPage key={crmId} crmId={crmId} search={search} onSearch={onSearch} />
}
